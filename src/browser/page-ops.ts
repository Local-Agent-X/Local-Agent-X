/**
 * Page-level operations that don't belong in BrowserManager's core. Pure
 * functions that take a Page (and optionally a BrowserContext) — keeps
 * browser.ts under the file-size cap without hiding the operation semantics.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { MAX_TEXT_LENGTH } from "./launcher.js";
import { wrapExternalContent } from "../sanitize.js";
import { getLaxDir } from "../lax-data-dir.js";

/** Extract visible text from body or a specific selector. */
export async function extractTextFrom(page: Page, selector?: string): Promise<string> {
  let text: string;
  if (selector) {
    const el = await page.$(selector);
    text = el ? await el.innerText() : `Element not found: ${selector}`;
  } else {
    text = await page.innerText("body");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
  }
  return wrapExternalContent(text, "browser.extract", { url: page.url(), selector: selector || "body" });
}

/** Capture a screenshot, persist the full PNG, and return a reference the model
 *  can actually SEE via `view_image`.
 *
 *  The prior implementation base64-encoded the buffer, sliced it to 200 chars,
 *  and returned that fragment inside a `[base64:…]` marker — then discarded the
 *  real bytes. Nothing downstream reconstitutes an image from that string (the
 *  canonical vision path is a ToolResult `_image` envelope / a `view_image`
 *  read), so every "let me screenshot to check the layout" flow was a silent
 *  no-op that read as success. We now write the whole PNG to the uploads dir —
 *  the same folder `view_image` resolves by basename — and hand back its path,
 *  mirroring preview-tools' render→view_image pattern. */
export async function screenshotAsBase64(page: Page, engine: string): Promise<string> {
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  // Empty buffers come from Playwright timeout/closed-page paths — silently
  // returning a "Screenshot captured" prefix on a 0-byte buffer is the worst
  // kind of fake-pass. Throw so the outer handler surfaces it as an error.
  if (!buffer || buffer.length === 0) {
    throw new Error("Screenshot failed: empty buffer (page may have closed or timed out).");
  }
  const title = await page.title();
  const url = page.url();
  const dir = join(getLaxDir(), "uploads");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `browser-screenshot-${Date.now()}.png`);
  writeFileSync(file, buffer);
  return `Screenshot captured\nURL: ${url}\nTitle: ${title}\nEngine: ${engine}\nSize: ${buffer.length} bytes\nSaved: ${file}\n\nUse the 'view_image' tool on that path to SEE the page, or the 'extract' action to read its text content.`;
}

// page.evaluate has no built-in timeout, so a model script that awaits
// something that never resolves would hang the call until the per-tool wedge
// deadline (toolMs−1s ≈ 29s) force-kills the whole session. Bound it well under
// that so a bad script fails THIS call with a clean error and the session lives.
// A SYNCHRONOUSLY-infinite script still blocks the page's JS thread and falls
// through to the wedge — CDP can't interrupt that without a reset.
const EVAL_TIMEOUT = 12_000;

async function evaluateWithTimeout(page: Page, expression: string, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = page.evaluate(expression);
  work.catch(() => { /* swallow the late rejection if the timeout already won */ });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`evaluate exceeded ${ms}ms — the script may be awaiting something that never resolves`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run an arbitrary JS expression in the page. Caller must pre-check it.
 *  Wraps the script intelligently so the agent can write either an
 *  expression OR statements with `return`:
 *    - `document.title`              → wrapped as expression
 *    - `return document.title`       → wrapped as IIFE
 *    - `for (...) { return ... }`    → wrapped as IIFE
 *  Without this wrap, page.evaluate(string) treats the input as an
 *  expression, so any top-level `return` errors with "Illegal return
 *  statement" — that's been silently breaking agent browser flows.
 */
export async function evaluateScript(page: Page, script: string, timeoutMs = EVAL_TIMEOUT): Promise<string> {
  const trimmed = script.trim().replace(/;\s*$/, "");
  // Playwright's page.evaluate(string) treats the input as an EXPRESSION
  // position. That means top-level `const`/`let`/`var`, multi-statement
  // scripts, and `return` statements all fail with a SyntaxError unless
  // we wrap them in a function. Live failure (2026-05-13, customer PO-entry workflow
  // PO entry): agent wrote `const els = ...; els.forEach(...)`, every
  // call surfaced as "Unexpected token 'const'", agent then pivoted to
  // `new Function("...")` to defeat the syntax error and hit the anti-
  // dynamic-eval guard. Both symptoms vanish if we wrap proactively.
  //
  // Detection: wrap in IIFE when ANY of these are present (= it's not a
  // single-expression script):
  //   - explicit `return` statement
  //   - statement separator (`;` or newline) — multi-statement form
  //   - declaration keyword at any boundary (`const`/`let`/`var`/`function`)
  //   - control-flow keyword (`if`/`for`/`while`/`switch`/`try`)
  // Else: single expression — parenthesize so the evaluator returns its
  // value (e.g. `document.title` → `(document.title)` → page title).
  //
  // The IIFE path is conservative — it returns whatever the body returns.
  // If the agent's script has side effects but no `return`, the result is
  // `undefined`, which serializes to "(no return value)" below. That's the
  // correct semantic; the agent should add `return X` if it wants a value.
  const needsIife =
    /(^|[\s;{}])return\b/.test(trimmed) ||
    /[;\n]/.test(trimmed) ||
    /(^|[\s;{}])(const|let|var|function|async\s+function)\b/.test(trimmed) ||
    /(^|[\s;{}])(if|for|while|switch|try)\s*[({]/.test(trimmed);
  const wrapped = needsIife
    ? `(() => { ${trimmed} })()`
    : `(${trimmed})`;
  const result = await evaluateWithTimeout(page, wrapped, timeoutMs);
  let output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (output && output.length > MAX_TEXT_LENGTH) {
    output = output.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
  }
  return output ?? "(no return value)";
}

/** List the session's own open tabs (scoped to one session, not the whole
 *  shared context, so sessions don't see each other's tabs). */
export async function listTabs(pages: Page[], active: Page | null): Promise<string> {
  if (pages.length === 0) return "No browser session active.";
  const currentUrl = active?.url() || "";
  const tabs: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    try {
      const title = await p.title();
      const url = p.url();
      const act = url === currentUrl ? " ← active" : "";
      tabs.push(`[${i}] ${title || "(no title)"} — ${url}${act}`);
    } catch {
      tabs.push(`[${i}] (disconnected)`);
    }
  }
  return `${pages.length} tab(s) open:\n${tabs.join("\n")}`;
}

export interface SwitchTabResult {
  ok: boolean;
  page: Page | null;
  message: string;
}

/** Resolve the target page for a switch-tab action without mutating manager state. */
export async function resolveSwitchTab(
  pages: Page[],
  index: number
): Promise<SwitchTabResult> {
  if (pages.length === 0) return { ok: false, page: null, message: "No browser session active." };
  if (index < 0 || index >= pages.length) {
    return {
      ok: false,
      page: null,
      message: `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${pages.length - 1}).`,
    };
  }
  const page = pages[index];
  await page.bringToFront();
  const title = await page.title();
  const url = page.url();
  return { ok: true, page, message: `Switched to tab [${index}]: ${title} — ${url}` };
}

/** Short page-info string. */
export async function pageInfo(page: Page | null, engine: string): Promise<string> {
  if (!page || page.isClosed()) return "No browser session active. Use 'navigate' to open a page.";
  const title = await page.title();
  const url = page.url();
  return `Browser active\nEngine: ${engine}\nURL: ${url}\nTitle: ${title}`;
}

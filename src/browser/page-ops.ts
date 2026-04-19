/**
 * Page-level operations that don't belong in BrowserManager's core. Pure
 * functions that take a Page (and optionally a BrowserContext) — keeps
 * browser.ts under the file-size cap without hiding the operation semantics.
 */
import type { BrowserContext, Page } from "playwright";
import { MAX_TEXT_LENGTH } from "./launcher.js";
import { wrapExternalContent } from "../sanitize.js";

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

/** Capture a base64 screenshot with metadata header. */
export async function screenshotAsBase64(page: Page, engine: string): Promise<string> {
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  const base64 = buffer.toString("base64");
  const title = await page.title();
  const url = page.url();
  return `Screenshot captured\nURL: ${url}\nTitle: ${title}\nEngine: ${engine}\nSize: ${buffer.length} bytes\n\n[base64:${base64.slice(0, 200)}...]\n\nUse 'extract' action to read the page text content.`;
}

/** Run an arbitrary JS expression in the page. Caller must pre-check it. */
export async function evaluateScript(page: Page, script: string): Promise<string> {
  const result = await page.evaluate(script);
  let output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (output && output.length > MAX_TEXT_LENGTH) {
    output = output.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
  }
  return output ?? "(no return value)";
}

/** List all open tabs in the given context. */
export async function listTabs(context: BrowserContext | null, active: Page | null): Promise<string> {
  if (!context) return "No browser session active.";
  const pages = context.pages();
  if (pages.length === 0) return "No tabs open.";
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
  context: BrowserContext | null,
  index: number
): Promise<SwitchTabResult> {
  if (!context) return { ok: false, page: null, message: "No browser session active." };
  const pages = context.pages();
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

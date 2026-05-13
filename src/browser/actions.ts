/**
 * Browser actions with progressive fallback.
 *
 * Resolution order when clicking/filling a DurableRef:
 *   1. role + name (Playwright getByRole) — most reliable
 *   2. visible text (getByText)
 *   3. XPath stored in the ref
 *   4. bounding-box click (last resort — will miss if layout changed)
 *
 * If the ref is offscreen we scroll it into view first. If text-based search
 * finds nothing, we scroll down a viewport at a time and retry — saves the
 * agent from giving up on virtualized/long lists.
 */
import type { Frame, Page } from "playwright";
import type { DurableRef, ObservationRegistry } from "./observation.js";
import { waitForStability } from "./stability.js";

export interface ActionResult {
  ok: boolean;
  via: "role" | "text" | "xpath" | "coords" | "none";
  message: string;
}

const CLICK_TIMEOUT = 8_000;
const SCROLL_TIMEOUT = 2_000;

/**
 * Pick the right Playwright Frame for a ref. Main-frame refs (no
 * frameUrl) resolve against `page`. Same-origin iframe refs (`frameUrl`
 * is set) resolve against the matching child Frame.
 *
 * Matching strategy: prefer URL equality, fall back to the first non-
 * main frame if URL didn't match (covers about:blank / srcdoc iframes
 * whose URL we couldn't capture). If still no match, fall back to the
 * main page — the coords-based click can still hit the right pixel
 * because extract.ts now records iframe-offset rects.
 */
function resolveFrame(page: Page, ref: DurableRef): Frame | Page {
  if (!ref.frameUrl && ref.frameUrl !== "") return page;
  const frames = page.frames();
  if (ref.frameUrl) {
    const byUrl = frames.find(f => f.url() === ref.frameUrl);
    if (byUrl) return byUrl;
  }
  // Empty-string frameUrl (srcdoc/about:blank iframes) or src that
  // didn't survive — pick the first non-main frame as a last resort.
  const nonMain = frames.find(f => f !== page.mainFrame());
  return nonMain ?? page;
}

export async function clickRef(
  page: Page,
  registry: ObservationRegistry,
  refId: number
): Promise<ActionResult> {
  const ref = registry.get(refId);
  if (!ref) {
    return { ok: false, via: "none", message: `Ref [${refId}] not found — take a fresh observation` };
  }

  await scrollRefIntoView(page, ref);
  const trace = await tryResolutionChain(page, ref, "click");
  if (trace.ok) return trace;

  await page.waitForTimeout(1500);
  return tryResolutionChain(page, ref, "click");
}

export async function fillRef(
  page: Page,
  registry: ObservationRegistry,
  refId: number,
  value: string
): Promise<ActionResult> {
  const ref = registry.get(refId);
  if (!ref) {
    return { ok: false, via: "none", message: `Ref [${refId}] not found — take a fresh observation` };
  }

  await scrollRefIntoView(page, ref);
  const trace = await tryResolutionChain(page, ref, "fill", value);
  if (trace.ok) return trace;
  await page.waitForTimeout(1500);
  return tryResolutionChain(page, ref, "fill", value);
}

async function scrollRefIntoView(page: Page, ref: DurableRef): Promise<void> {
  if (ref.inViewport || !ref.xpath) return;
  try {
    const root = resolveFrame(page, ref);
    await root.locator(`xpath=${ref.xpath}`).first().scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT });
  } catch {
    // Element may have moved — resolution chain handles the rest.
  }
}

async function tryResolutionChain(
  page: Page,
  ref: DurableRef,
  op: "click" | "fill",
  value = ""
): Promise<ActionResult> {
  // Pick the right frame up front — main page or same-origin iframe.
  // The role/text/xpath locators all need to be scoped to the frame that
  // actually contains the element; otherwise Playwright queries the main
  // frame's accessibility tree and finds nothing (the regression that
  // broke Thriveventory PO entry).
  const root = resolveFrame(page, ref);
  const inIframe = root !== page;
  const viaSuffix = inIframe ? " (iframe)" : "";

  if (ref.role && ref.name) {
    try {
      const loc = root.getByRole(ref.role as Parameters<Page["getByRole"]>[0], { name: ref.name, exact: false });
      if ((await loc.count()) > 0) {
        if (op === "click") await loc.first().click({ timeout: CLICK_TIMEOUT });
        else await loc.first().fill(value, { timeout: CLICK_TIMEOUT });
        return { ok: true, via: "role", message: `[${ref.id}] ${op} via role/name (${ref.role} "${ref.name}")${viaSuffix}` };
      }
    } catch { /* fall through */ }
  }

  if (op === "click" && ref.name) {
    try {
      const loc = root.getByText(ref.name, { exact: false });
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: CLICK_TIMEOUT });
        return { ok: true, via: "text", message: `[${ref.id}] click via visible text "${ref.name}"${viaSuffix}` };
      }
    } catch { /* fall through */ }
  }

  if (ref.xpath) {
    try {
      const loc = root.locator(`xpath=${ref.xpath}`);
      if ((await loc.count()) > 0) {
        if (op === "click") await loc.first().click({ timeout: CLICK_TIMEOUT });
        else await loc.first().fill(value, { timeout: CLICK_TIMEOUT });
        return { ok: true, via: "xpath", message: `[${ref.id}] ${op} via XPath${viaSuffix}` };
      }
    } catch { /* fall through */ }
  }

  // Coords fallback uses the page-level mouse — extract.ts now records
  // iframe-offset coordinates in ref.rect, so clicking at those coords
  // hits the iframe pixel correctly regardless of which frame owns the
  // element. `fill` has no coords path because there's no "type at this
  // pixel" — keep the limitation; agents that need iframe-fill use the
  // role/xpath paths above which now route via root.
  if (op === "click" && ref.rect.width > 0 && ref.rect.height > 0) {
    try {
      await page.mouse.click(ref.rect.x, ref.rect.y);
      return { ok: true, via: "coords", message: `[${ref.id}] click via coords (${ref.rect.x},${ref.rect.y})${viaSuffix} — layout-dependent, verify result` };
    } catch { /* fall through */ }
  }

  return {
    ok: false,
    via: "none",
    message: `[${ref.id}] ${ref.role} "${ref.name}"${viaSuffix} — all resolution strategies failed. Re-observe the page.`,
  };
}

/**
 * Click-by-visible-text without a snapshot. Tries text match, then role-scoped
 * text match. If nothing is found in the current viewport, scrolls down up to
 * twice and retries — handles virtualized lists and long-scroll pages where
 * the target is below the fold.
 */
export async function clickByText(page: Page, text: string): Promise<ActionResult> {
  await waitForStability(page);
  const vh = page.viewportSize()?.height ?? 800;

  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await tryClickByText(page, text);
    if (result.ok) return result;
    if (attempt < 2) {
      await page.evaluate(`window.scrollBy(0, ${vh})`);
      await page.waitForTimeout(400);
    }
  }
  return { ok: false, via: "none", message: `no element matching text "${text}" found (scrolled 2 viewports)` };
}

async function tryClickByText(page: Page, text: string): Promise<ActionResult> {
  try {
    const loc = page.getByText(text, { exact: false });
    if ((await loc.count()) > 0) {
      await loc.first().scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT }).catch(() => {});
      await loc.first().click({ timeout: CLICK_TIMEOUT });
      return { ok: true, via: "text", message: `clicked visible text "${text}"` };
    }
  } catch { /* continue */ }

  for (const role of ["button", "link", "menuitem", "tab", "checkbox"] as const) {
    try {
      const loc = page.getByRole(role, { name: text, exact: false });
      if ((await loc.count()) > 0) {
        await loc.first().scrollIntoViewIfNeeded({ timeout: SCROLL_TIMEOUT }).catch(() => {});
        await loc.first().click({ timeout: CLICK_TIMEOUT });
        return { ok: true, via: "role", message: `clicked ${role} "${text}"` };
      }
    } catch { /* continue */ }
  }
  return { ok: false, via: "none", message: `no match for "${text}" in current viewport` };
}

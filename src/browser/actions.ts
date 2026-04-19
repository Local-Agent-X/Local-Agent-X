/**
 * Browser actions with progressive fallback.
 *
 * Resolution order when clicking/filling a DurableRef:
 *   1. role + name (Playwright getByRole) — most reliable
 *   2. visible text (getByText)
 *   3. XPath stored in the ref
 *   4. bounding-box click (last resort — will miss if layout changed)
 *
 * Each step retries once after a short wait to let SPA re-renders settle.
 */
import type { Page } from "playwright";
import type { DurableRef, ObservationRegistry } from "./observation.js";
import { waitForStability } from "./stability.js";

export interface ActionResult {
  ok: boolean;
  via: "role" | "text" | "xpath" | "coords" | "none";
  message: string;
}

const CLICK_TIMEOUT = 8_000;

export async function clickRef(
  page: Page,
  registry: ObservationRegistry,
  refId: number
): Promise<ActionResult> {
  const ref = registry.get(refId);
  if (!ref) {
    return { ok: false, via: "none", message: `Ref [${refId}] not found — take a fresh observation` };
  }

  const trace = await tryResolutionChain(page, ref, "click");
  if (trace.ok) return trace;

  // One more attempt after a pause in case the page was still rendering.
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

  const trace = await tryResolutionChain(page, ref, "fill", value);
  if (trace.ok) return trace;
  await page.waitForTimeout(1500);
  return tryResolutionChain(page, ref, "fill", value);
}

async function tryResolutionChain(
  page: Page,
  ref: DurableRef,
  op: "click" | "fill",
  value = ""
): Promise<ActionResult> {
  // 1) role + name
  if (ref.role && ref.name) {
    try {
      const loc = page.getByRole(ref.role as Parameters<Page["getByRole"]>[0], { name: ref.name, exact: false });
      if ((await loc.count()) > 0) {
        if (op === "click") await loc.first().click({ timeout: CLICK_TIMEOUT });
        else await loc.first().fill(value, { timeout: CLICK_TIMEOUT });
        return { ok: true, via: "role", message: `[${ref.id}] ${op} via role/name (${ref.role} "${ref.name}")` };
      }
    } catch { /* fall through */ }
  }

  // 2) text match (for click only — fill by text doesn't make sense)
  if (op === "click" && ref.name) {
    try {
      const loc = page.getByText(ref.name, { exact: false });
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: CLICK_TIMEOUT });
        return { ok: true, via: "text", message: `[${ref.id}] click via visible text "${ref.name}"` };
      }
    } catch { /* fall through */ }
  }

  // 3) XPath
  if (ref.xpath) {
    try {
      const loc = page.locator(`xpath=${ref.xpath}`);
      if ((await loc.count()) > 0) {
        if (op === "click") await loc.first().click({ timeout: CLICK_TIMEOUT });
        else await loc.first().fill(value, { timeout: CLICK_TIMEOUT });
        return { ok: true, via: "xpath", message: `[${ref.id}] ${op} via XPath` };
      }
    } catch { /* fall through */ }
  }

  // 4) coordinate click (click only — coords don't work for fill)
  if (op === "click" && ref.rect.width > 0 && ref.rect.height > 0) {
    try {
      await page.mouse.click(ref.rect.x, ref.rect.y);
      return { ok: true, via: "coords", message: `[${ref.id}] click via coords (${ref.rect.x},${ref.rect.y}) — layout-dependent, verify result` };
    } catch { /* fall through */ }
  }

  return {
    ok: false,
    via: "none",
    message: `[${ref.id}] ${ref.role} "${ref.name}" — all resolution strategies failed. Re-observe the page.`,
  };
}

/**
 * Convenience: click-by-visible-text when the agent didn't take a snapshot
 * first. Tries text match, then role-scoped text match. Does NOT use refs.
 */
export async function clickByText(page: Page, text: string): Promise<ActionResult> {
  await waitForStability(page);
  try {
    const loc = page.getByText(text, { exact: false });
    if ((await loc.count()) > 0) {
      await loc.first().click({ timeout: CLICK_TIMEOUT });
      return { ok: true, via: "text", message: `clicked visible text "${text}"` };
    }
  } catch { /* continue */ }

  for (const role of ["button", "link", "menuitem", "tab", "checkbox"] as const) {
    try {
      const loc = page.getByRole(role, { name: text, exact: false });
      if ((await loc.count()) > 0) {
        await loc.first().click({ timeout: CLICK_TIMEOUT });
        return { ok: true, via: "role", message: `clicked ${role} "${text}"` };
      }
    } catch { /* continue */ }
  }
  return { ok: false, via: "none", message: `no element matching text "${text}" found` };
}

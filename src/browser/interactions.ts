/**
 * Ref/text interaction, scroll, and fingerprint operations extracted from
 * BrowserManager. Free functions that take an explicit Page +
 * ObservationRegistry — keeps manager.ts under the file-size cap without
 * hiding the interaction semantics. The BrowserBackend methods on
 * BrowserManager remain the public surface; they delegate here.
 */
import type { Page } from "playwright";
import { ObservationRegistry } from "./observation.js";
import { clickRef, fillRef, clickByText as clickByTextAction } from "./actions.js";
import { waitForStability } from "./stability.js";
import type { InteractionResult, ScrollOptions } from "./backend.js";

// Cheap progress fingerprint: URL + title + text length + element count.
// Deliberately bypasses the observation registry so reading it never
// disturbs the diff state the agent's own observe() calls depend on. A click
// that toggles a seat (changing the "selected / total" text) or loads new DOM
// moves at least one of these; a no-op action leaves all four identical.
// Returns "" if the page can't be read (mid-navigation) — the caller treats
// that as "unknown", not "no progress". See progress-tracker.ts.
export async function fingerprintPage(page: Page): Promise<string> {
  try {
    const sig = await page.evaluate(
      "[location.href, document.title, (document.body && document.body.textContent ? document.body.textContent.length : 0), document.querySelectorAll('*').length].join('|')",
    );
    return typeof sig === "string" ? sig : "";
  } catch {
    return "";
  }
}

export async function scrollPage(page: Page, registry: ObservationRegistry, opts: ScrollOptions): Promise<string> {
  if (opts.refId !== undefined) {
    const ref = registry.get(opts.refId);
    if (!ref) return `Ref [${opts.refId}] not found — re-observe first`;
    try {
      const loc = page.locator(`xpath=${ref.xpath}`);
      await loc.first().scrollIntoViewIfNeeded({ timeout: 3000 });
      await waitForStability(page, { maxWait: 1500 });
      return `Scrolled ref [${opts.refId}] into view`;
    } catch (e) {
      return `Could not scroll ref [${opts.refId}]: ${(e as Error).message}`;
    }
  }
  const amount = opts.amount ?? 600;
  const dir = opts.direction ?? "down";
  if (dir === "top") {
    await page.evaluate("window.scrollTo(0, 0)");
  } else if (dir === "bottom") {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
  } else {
    const delta = dir === "up" ? -amount : amount;
    await page.evaluate(`window.scrollBy(0, ${delta})`);
  }
  await waitForStability(page, { maxWait: 1500 });
  return `Scrolled ${dir}${opts.refId ? "" : ` (${amount}px)`}`;
}

export async function clickRefOn(page: Page, registry: ObservationRegistry, ref: number): Promise<InteractionResult> {
  let result = await clickRef(page, registry, ref);
  if (!result.ok) {
    await registry.observe(page);
    result = await clickRef(page, registry, ref);
  }
  if (!result.ok) {
    const refreshed = ObservationRegistry.format(await registry.observe(page));
    return { ok: false, text: `${result.message}\n\nCurrent page:\n\n${refreshed}` };
  }
  await waitForStability(page, { maxWait: 2500 });
  const after = ObservationRegistry.format(await registry.observe(page));
  return { ok: true, text: `${result.message}\nPage: ${page.url()}\n\n${after}` };
}

export async function fillRefOn(page: Page, registry: ObservationRegistry, ref: number, value: string): Promise<InteractionResult> {
  let result = await fillRef(page, registry, ref, value);
  if (!result.ok) {
    await registry.observe(page);
    result = await fillRef(page, registry, ref, value);
  }
  if (!result.ok) {
    const refreshed = ObservationRegistry.format(await registry.observe(page));
    return { ok: false, text: `${result.message}\n\nCurrent page:\n\n${refreshed}` };
  }
  return { ok: true, text: `${result.message} — ${value.length} chars` };
}

export async function clickTextOn(page: Page, registry: ObservationRegistry, text: string): Promise<InteractionResult> {
  const result = await clickByTextAction(page, text);
  if (!result.ok) return { ok: false, text: result.message };
  await waitForStability(page, { maxWait: 2500 });
  const after = ObservationRegistry.format(await registry.observe(page));
  return { ok: true, text: `${result.message}\nPage: ${page.url()}\n\n${after}` };
}

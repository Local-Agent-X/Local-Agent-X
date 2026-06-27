import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import { clickByText } from "./actions.js";

/**
 * Fake page whose text/role lookups always "match" one element. The element's
 * click resolves immediately when `clickable`, or rejects only after its full
 * given timeout when not — the way Playwright treats a covered/animating
 * overlay button. `clickTimeouts` records every timeout the search requested so
 * the budget can be asserted.
 */
function fakePage(clickable: boolean): { page: Page; clickTimeouts: number[] } {
  const clickTimeouts: number[] = [];
  const loc = {
    first() { return loc; },
    async count() { return 1; },
    async scrollIntoViewIfNeeded() { /* immediate */ },
    click({ timeout }: { timeout: number }) {
      clickTimeouts.push(timeout);
      if (clickable) return Promise.resolve();
      return new Promise((_, reject) => setTimeout(() => reject(new Error("not actionable")), timeout));
    },
  };
  const page = {
    viewportSize: () => ({ width: 1280, height: 800 }),
    getByText: () => loc,
    getByRole: () => loc,
    async evaluate() { return undefined; },
    async waitForTimeout(ms: number) { return new Promise((r) => setTimeout(r, ms)); },
    async waitForLoadState() { /* settled */ },
    async waitForFunction() { /* settled */ },
  } as unknown as Page;
  return { page, clickTimeouts };
}

describe("clickByText budget", () => {
  it("fails fast on an unclickable overlay instead of stacking past the wedge", async () => {
    const { page, clickTimeouts } = fakePage(false);
    const budget = 600;
    const start = Date.now();
    const r = await clickByText(page, "Cancel", budget);
    const elapsed = Date.now() - start;

    expect(r.ok).toBe(false);
    // The whole search must finish within the budget (+ at most one in-flight
    // click), NOT the old 3 attempts × 6 probes × 8s ≈ 144s stack.
    expect(elapsed).toBeLessThan(budget + 8_000);
    // Every requested click timeout is bounded by the time left in the budget.
    expect(clickTimeouts.every((t) => t <= budget)).toBe(true);
  });

  it("clicks immediately when the element is actionable (happy path intact)", async () => {
    const { page, clickTimeouts } = fakePage(true);
    const r = await clickByText(page, "Accept all");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("text");
    expect(clickTimeouts[0]).toBeGreaterThan(0);
    expect(clickTimeouts[0]).toBeLessThanOrEqual(8_000);
  });
});

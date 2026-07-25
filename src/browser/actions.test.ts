import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import { clickByText, fillRef } from "./actions.js";
import type { DurableRef, ObservationRegistry } from "./observation.js";

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

/**
 * EXACT-identity resolution on the CDP path. `getByRole({name})` matches the
 * ACCESSIBLE name, which excludes the HTML `name` attribute outright — so
 * `<input id="po-number" name="PO NUMBER">` (empty accessible name) was
 * unreachable by every strategy the chain had. These pin that a ref carrying
 * stable identifiers is resolved by them, before any fuzzy strategy runs, and
 * with the same nearest-to-observed-centre tie-break the in-app chain uses.
 */
function fakeLocatorPage(matches: Record<string, Array<{ x: number; y: number }>>) {
  const filled: Array<{ sel: string; index: number; value: string }> = [];
  const fuzzy: string[] = [];
  const locatorFor = (sel: string, index: number) => ({
    first: () => locatorFor(sel, 0),
    nth: (i: number) => locatorFor(sel, i),
    async count() { return (matches[sel] ?? []).length; },
    async boundingBox() {
      const box = (matches[sel] ?? [])[index];
      return box ? { x: box.x, y: box.y, width: 0, height: 0 } : null;
    },
    async fill(value: string) {
      if (!(matches[sel] ?? [])[index]) throw new Error("no such element");
      filled.push({ sel, index, value });
    },
    async click() { /* unused here */ },
    async scrollIntoViewIfNeeded() { /* immediate */ },
  });
  const fuzzyLocator = (label: string) => {
    const loc = {
      first: () => loc,
      async count() { fuzzy.push(label); return 1; },
      async fill(value: string) { filled.push({ sel: label, index: 0, value }); },
      async click() { /* unused */ },
      async scrollIntoViewIfNeeded() { /* immediate */ },
    };
    return loc;
  };
  const page = {
    frames: () => [page.mainFrame()],
    mainFrame: () => page,
    locator: (sel: string) => locatorFor(sel, 0),
    getByRole: () => fuzzyLocator("role"),
    getByText: () => fuzzyLocator("text"),
    async waitForTimeout() { /* no retry delay in tests */ },
  } as unknown as Page & { mainFrame(): unknown };
  return { page: page as unknown as Page, filled, fuzzy };
}

function mkRef(over: Partial<DurableRef> = {}): DurableRef {
  return {
    id: 12,
    signature: "textbox|PO NUMBER|INPUT|div",
    role: "textbox",
    name: "PO NUMBER",
    tag: "INPUT",
    type: "text",
    xpath: "/div[1]/input[1]",
    inViewport: true,
    lastSeen: 1,
    rect: { x: 140, y: 110, width: 80, height: 20 },
    ...over,
  };
}

function registryWith(ref: DurableRef): ObservationRegistry {
  return { recoverStaleRef: () => ref } as unknown as ObservationRegistry;
}

describe("exact stable-identifier resolution (CDP path)", () => {
  it("fills by unique id without ever consulting the fuzzy strategies", async () => {
    const { page, filled, fuzzy } = fakeLocatorPage({ 'input[id="po-number"]': [{ x: 100, y: 100 }] });
    const ref = mkRef({ ids: { id: "po-number", name: "PO NUMBER" } });
    const r = await fillRef(page, registryWith(ref), 12, "PO-4471");

    expect(r.ok).toBe(true);
    expect(r.via).toBe("exact");
    expect(r.message).toContain('id="po-number"');
    expect(filled).toEqual([{ sel: 'input[id="po-number"]', index: 0, value: "PO-4471" }]);
    expect(fuzzy).toEqual([]);
  });

  it("resolves by HTML name when there is no id — the attribute getByRole cannot see", async () => {
    const { page, filled } = fakeLocatorPage({ 'input[name="PO NUMBER"]': [{ x: 100, y: 100 }] });
    const ref = mkRef({ ids: { name: "PO NUMBER" } });
    const r = await fillRef(page, registryWith(ref), 12, "PO-4471");
    expect(r.via).toBe("exact");
    expect(filled[0].sel).toBe('input[name="PO NUMBER"]');
  });

  it("picks the candidate nearest the observed centre when a key is shared", async () => {
    // Three fields share the key; the ref was observed at (140,110).
    const { page, filled } = fakeLocatorPage({
      'input[name="qty"]': [{ x: 100, y: 400 }, { x: 130, y: 105 }, { x: 100, y: 700 }],
    });
    const ref = mkRef({ name: "qty", ids: { name: "qty" } });
    await fillRef(page, registryWith(ref), 12, "3");
    expect(filled[0].index).toBe(1);
  });

  it("falls through to the fuzzy chain when the exact selector matches nothing", async () => {
    const { page, fuzzy } = fakeLocatorPage({});
    const ref = mkRef({ ids: { id: "stale-id" } });
    const r = await fillRef(page, registryWith(ref), 12, "x");
    expect(r.via).toBe("role");
    expect(fuzzy).toContain("role");
  });

  it("leaves a ref with no durable identity on its original path", async () => {
    const { page, fuzzy } = fakeLocatorPage({});
    const r = await fillRef(page, registryWith(mkRef()), 12, "x");
    expect(r.via).toBe("role");
    expect(fuzzy).toEqual(["role"]);
  });
});

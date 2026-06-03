import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserManager } from "./manager.js";

// Post-fill readback policy contract (per Chunk C / fill-mask refactor):
//   1. value matches    → returns "Filled ... with value (N chars)"
//   2. value mismatches  → THROWS  "Fill did not land: expected 'X' got 'Y'"
//   3. empty + type=password → ok with "verification skipped: masked input"
//   4. empty + non-password  → throws (treated as a real mismatch)
//   5. readback machinery throws → ok with "verification skipped: readback failed"
//
// We don't spin up Playwright — we stub getPage() with a hand-rolled page.

interface FakeLocator {
  inputValue: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
}

interface FakePage {
  waitForSelector: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  locator: (selector: string) => FakeLocator;
}

function buildPage(opts: {
  readback: string | (() => Promise<string>);
  attrType?: string | null;
}): FakePage {
  return {
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    locator: () => ({
      inputValue: async () =>
        typeof opts.readback === "function" ? opts.readback() : opts.readback,
      getAttribute: async () => opts.attrType ?? null,
    }),
  };
}

function makeManager(page: FakePage): BrowserManager {
  const mgr = new BrowserManager("test-session");
  // Replace getPage so no real browser is touched.
  (mgr as unknown as { getPage: () => Promise<unknown> }).getPage = vi
    .fn()
    .mockResolvedValue(page);
  return mgr;
}

describe("BrowserManager.fill — readback policy", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns ok when the readback matches the filled value", async () => {
    const page = buildPage({ readback: "hello" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#user", "hello");

    expect(result).toBe(`Filled "#user" with value (5 chars)`);
    expect(page.waitForSelector).toHaveBeenCalledWith("#user", { state: "visible", timeout: 5000 });
    expect(page.fill).toHaveBeenCalledWith("#user", "hello", expect.any(Object));
  });

  it("throws when the readback value does NOT match the filled value", async () => {
    const page = buildPage({ readback: "WRONG" });
    const mgr = makeManager(page);

    await expect(mgr.fill("#user", "hello")).rejects.toThrow(
      /Fill did not land: expected 'hello' got 'WRONG'/,
    );
  });

  it("returns ok with masked-input note when readback is empty and type=password", async () => {
    const page = buildPage({ readback: "", attrType: "password" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#pw", "hunter2");

    expect(result).toBe(`Filled "#pw" (verification skipped: masked input)`);
  });

  it("returns ok normally when a password input echoes back its real value", async () => {
    // Some password fields aren't really masked at the DOM level (e.g. show-password toggles).
    // If inputValue() returns the same string, normal verification path wins — no skip note.
    const page = buildPage({ readback: "hunter2", attrType: "password" });
    const mgr = makeManager(page);

    const result = await mgr.fill("#pw", "hunter2");

    expect(result).toBe(`Filled "#pw" with value (7 chars)`);
    expect(result).not.toContain("verification skipped");
  });

  it("returns ok with readback-failed note when the locator itself throws", async () => {
    // Simulate post-fill detachment / navigation. The successful fill must not
    // be retroactively reported as failed just because readback machinery broke.
    const page = buildPage({
      readback: () => Promise.reject(new Error("Target closed")),
    });
    const mgr = makeManager(page);

    const result = await mgr.fill("#user", "hello");

    expect(result).toBe(`Filled "#user" (verification skipped: readback failed)`);
  });

  it("throws when readback returns empty and the input is NOT a password", async () => {
    // An empty readback on a plain text input is a real mismatch — not a mask.
    const page = buildPage({ readback: "", attrType: "text" });
    const mgr = makeManager(page);

    await expect(mgr.fill("#user", "hello")).rejects.toThrow(/Fill did not land/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import type { RawElement } from "./extract.js";

// Sub-op seams mocked so ObservationRegistry.observe runs against a bare fake
// page. The wedge/epoch path is covered end-to-end by wedge-recovery.test.ts.
vi.mock("./stability.js", () => ({ waitForStability: vi.fn(async () => {}) }));
vi.mock("./extract.js", () => ({ extractInteractiveElements: vi.fn(async () => []) }));
vi.mock("./modal-detector.js", () => ({ detectObstructions: vi.fn(async () => []) }));
vi.mock("./iframe-detector.js", () => ({ listIframes: vi.fn(async () => []) }));
vi.mock("./dialog-handler.js", () => ({ pendingDialogs: vi.fn(() => []) }));

import { BrowserWedgeError, ObservationRegistry, withWedgeTimeout } from "./observation.js";
import { extractInteractiveElements } from "./extract.js";
import { detectObstructions } from "./modal-detector.js";

const mockExtract = vi.mocked(extractInteractiveElements);
const mockObstructions = vi.mocked(detectObstructions);

const hung = <T>(): Promise<T> => new Promise<T>(() => { /* never settles — a wedged CDP scan */ });

const page = {
  url: () => "https://example.com/a",
  title: async () => "Example",
} as unknown as Page;

const SUBMIT: RawElement = {
  role: "button", name: "Submit", tag: "BUTTON", type: "", xpath: "/button[1]",
  signature: "button|Submit|BUTTON|form", inViewport: true,
  rect: { x: 10, y: 10, width: 80, height: 20 },
};

describe("withWedgeTimeout", () => {
  it("rejects with BrowserWedgeError when the scan exceeds the ceiling", async () => {
    await expect(withWedgeTimeout(hung(), 20)).rejects.toBeInstanceOf(BrowserWedgeError);
  });

  it("returns the result when the scan finishes in time", async () => {
    await expect(withWedgeTimeout(Promise.resolve("obs"), 1000)).resolves.toBe("obs");
  });
});

describe("degraded observation — a failed extractor must never masquerade as an empty page", () => {
  beforeEach(() => {
    mockExtract.mockReset();
    mockExtract.mockResolvedValue([]);
    mockObstructions.mockReset();
    mockObstructions.mockResolvedValue([]);
  });

  it("extractor rejection carries a degraded marker with the reason and preserves prior refs", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    const healthy = await reg.observe(page);
    expect(healthy.degraded).toBeUndefined();
    expect(healthy.currentRefs.map((r) => r.name)).toEqual(["Submit"]);

    mockExtract.mockRejectedValueOnce(new Error("Execution context was destroyed"));
    const obs = await reg.observe(page);

    // Before this change the failure was swallowed to [] — no marker, refs
    // wiped, and every prior element reported as removed.
    expect(obs.degraded).toEqual([{ op: "elements", reason: "Execution context was destroyed" }]);
    expect(obs.currentRefs.map((r) => r.name)).toEqual(["Submit"]);
    expect(obs.removed).toEqual([]);

    const text = ObservationRegistry.format(obs);
    expect(text).toContain("== OBSERVATION DEGRADED");
    expect(text).toContain("Element extraction FAILED: Execution context was destroyed");
    expect(text).toContain('browser({action:"screenshot"})');
    // The old silent path rendered this as a clean no-op observation.
    expect(text).not.toContain("Page unchanged since last observation");
  });

  it("extractor rejection on the FIRST observation never renders '0 interactive elements'", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockRejectedValueOnce(new Error("boom"));
    const obs = await reg.observe(page);

    expect(obs.degraded).toEqual([{ op: "elements", reason: "boom" }]);
    const text = ObservationRegistry.format(obs);
    // Old output: "Page: Example — https://example.com/a\n0 interactive elements:" —
    // indistinguishable from a genuinely empty page.
    expect(text).not.toContain("interactive elements:");
    expect(text).toContain("Interactive element list unavailable — extraction failed");
    expect(text).toContain('browser({action:"screenshot"})');
  });

  it("a degraded scan does not burn ref ids: the next healthy scan reuses them", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    const first = await reg.observe(page);
    const id = first.currentRefs[0].id;

    mockExtract.mockRejectedValueOnce(new Error("transient"));
    await reg.observe(page);

    mockExtract.mockResolvedValueOnce([SUBMIT]);
    const recovered = await reg.observe(page);
    expect(recovered.degraded).toBeUndefined();
    expect(recovered.currentRefs.map((r) => r.id)).toEqual([id]);
    expect(recovered.added).toEqual([]);
    expect(recovered.removed).toEqual([]);
  });

  it("obstruction-detector failure is marked without hiding the (honest) element list", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    mockObstructions.mockRejectedValueOnce(new Error("detector crashed"));
    const obs = await reg.observe(page);

    expect(obs.degraded).toEqual([{ op: "obstructions", reason: "detector crashed" }]);
    const text = ObservationRegistry.format(obs);
    expect(text).toContain("Obstruction detection FAILED: detector crashed");
    // Extraction succeeded — the element list still renders normally.
    expect(text).toContain("1 interactive elements:");
    expect(text).toContain("[1]<button>Submit</button>");
  });

  it("healthy page: no degraded marker and byte-identical output to before", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    const obs = await reg.observe(page);

    expect(obs.degraded).toBeUndefined();
    expect(ObservationRegistry.format(obs)).toBe(
      "Page: Example — https://example.com/a\n1 interactive elements:\n\n[1]<button>Submit</button>"
    );
  });
});

describe("viewport perception — a scroll must surface the newly-visible set, not 'Page unchanged'", () => {
  beforeEach(() => {
    mockExtract.mockReset();
    mockExtract.mockResolvedValue([]);
    mockObstructions.mockReset();
    mockObstructions.mockResolvedValue([]);
  });

  const ABOVE: RawElement = {
    role: "button", name: "Above", tag: "BUTTON", type: "", xpath: "/button[1]",
    signature: "button|Above|BUTTON|form", inViewport: true,
    rect: { x: 10, y: 10, width: 80, height: 20 },
  };
  const BELOW: RawElement = {
    role: "button", name: "Below", tag: "BUTTON", type: "", xpath: "/button[2]",
    signature: "button|Below|BUTTON|form", inViewport: false,
    rect: { x: 10, y: 900, width: 80, height: 20 },
  };

  it("exposes the CURRENT in-viewport set on every observation, and reports the scroll in format()", async () => {
    const reg = new ObservationRegistry();

    // Initial: ABOVE on screen, BELOW past the fold. `viewport` is the in-view
    // slice — distinct from `full`/`currentRefs`, which carry both.
    mockExtract.mockResolvedValueOnce([ABOVE, BELOW]);
    const first = await reg.observe(page);
    expect(first.isInitial).toBe(true);
    expect(first.viewport?.map((r) => r.name)).toEqual(["Above"]);
    expect(first.currentRefs.map((r) => r.name)).toEqual(["Above", "Below"]);

    // Scroll: SAME DOM (identical signatures → nothing added/removed/changed),
    // but the inViewport flags flip — ABOVE leaves the viewport, BELOW enters.
    mockExtract.mockResolvedValueOnce([
      { ...ABOVE, inViewport: false },
      { ...BELOW, inViewport: true },
    ]);
    const scrolled = await reg.observe(page);

    // (a) It is a pure scroll: no add/remove/change …
    expect(scrolled.added).toEqual([]);
    expect(scrolled.removed).toEqual([]);
    expect(scrolled.changed).toEqual([]);
    // … yet the observation exposes the NEW in-viewport set.
    expect(scrolled.viewport?.map((r) => r.name)).toEqual(["Below"]);
    expect(scrolled.viewportChanged).toBe(true);

    // (b) format() reports the viewport change instead of "Page unchanged".
    const text = ObservationRegistry.format(scrolled);
    expect(text).toContain("Viewport changed: 1 elements now visible");
    expect(text).not.toContain("Page unchanged since last observation");
  });

  it("no scroll → still 'Page unchanged' (the new branch never fires spuriously)", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([ABOVE, BELOW]);
    await reg.observe(page); // initial
    mockExtract.mockResolvedValueOnce([ABOVE, BELOW]); // identical viewport
    const again = await reg.observe(page);

    expect(again.viewportChanged).toBe(false);
    const text = ObservationRegistry.format(again);
    expect(text).toContain("Page unchanged since last observation");
    expect(text).not.toContain("Viewport changed");
  });
});

describe("recoverStaleRef — remapping a stale id after a page re-render", () => {
  beforeEach(() => {
    mockExtract.mockReset();
    mockExtract.mockResolvedValue([]);
    mockObstructions.mockReset();
    mockObstructions.mockResolvedValue([]);
  });

  it("returns the live ref directly when the id is still current", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);
    expect(reg.recoverStaleRef(1)?.name).toBe("Submit");
  });

  it("remaps by SIGNATURE when the element dropped out and came back under a new id", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page); // Submit = [1]
    mockExtract.mockResolvedValueOnce([]);
    await reg.observe(page); // Submit removed → retired
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    const back = await reg.observe(page); // Submit re-added under a NEW id

    const newId = back.currentRefs[0].id;
    expect(newId).not.toBe(1);
    expect(reg.get(1)).toBeUndefined();
    expect(reg.recoverStaleRef(1)?.id).toBe(newId);
  });

  it("falls back to a UNIQUE role+name match when the signature changed", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);
    // Re-render moved the button: same role+name, different ancestor chain.
    const moved = { ...SUBMIT, signature: "button|Submit|BUTTON|main", xpath: "/main/button[1]" };
    mockExtract.mockResolvedValueOnce([moved]);
    const obs = await reg.observe(page);

    const newId = obs.currentRefs[0].id;
    expect(reg.recoverStaleRef(1)?.id).toBe(newId);
  });

  it("refuses an AMBIGUOUS role+name remap — never guesses between two candidates", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);
    const twinA = { ...SUBMIT, signature: "button|Submit|BUTTON|header" };
    const twinB = { ...SUBMIT, signature: "button|Submit|BUTTON|footer" };
    mockExtract.mockResolvedValueOnce([twinA, twinB]);
    await reg.observe(page);

    expect(reg.recoverStaleRef(1)).toBeUndefined();
  });

  it("returns undefined for an id that never existed", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);
    expect(reg.recoverStaleRef(99)).toBeUndefined();
  });

  it("reset() clears tombstones — no remapping across an origin change", async () => {
    const reg = new ObservationRegistry();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);
    mockExtract.mockResolvedValueOnce([]);
    await reg.observe(page); // retire [1]
    reg.reset();
    mockExtract.mockResolvedValueOnce([SUBMIT]);
    await reg.observe(page);

    expect(reg.recoverStaleRef(1)?.id).toBe(1); // live hit only — [1] is the NEW ref
    // A retired-only id from before the reset must not remap.
    expect(reg.recoverStaleRef(2)).toBeUndefined();
  });
});

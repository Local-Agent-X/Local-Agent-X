// @vitest-environment happy-dom
//
// C7: unit tests for the pure width-clamp helper in
// public/js/chat-agent-feeds-resize.js (`clampAgentFeedsWidth`) that backs the
// right-rail drag-to-resize. The file is a browser global-script whose only
// top-level side effect is a DOM-guarded init (getElementById('agent-feeds') →
// null here → no-op), so — matching chat-agent-feeds-tree.test.ts — we load its
// source in a Function factory and lift out the pure function + its constants.
//
// clampAgentFeedsWidth touches no DOM and no storage: it's a pure numeric clamp
// with a default fallback, which is exactly the resize correctness we can test
// headlessly (the pointer-drag glue itself is DOM/pointer-event only — see the
// note at the bottom of this file).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let clampAgentFeedsWidth: (w: unknown) => number;
let MIN: number, MAX: number, DEFAULT: number;

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds-resize.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    src +
      "\nreturn { clampAgentFeedsWidth, AGENT_FEEDS_MIN, AGENT_FEEDS_MAX, AGENT_FEEDS_DEFAULT };"
  );
  const m = factory();
  clampAgentFeedsWidth = m.clampAgentFeedsWidth;
  MIN = m.AGENT_FEEDS_MIN;
  MAX = m.AGENT_FEEDS_MAX;
  DEFAULT = m.AGENT_FEEDS_DEFAULT;
});

describe("clampAgentFeedsWidth (C7 right-rail resize)", () => {
  it("bounds are the agreed [260,720] with a 320 default", () => {
    expect(MIN).toBe(260);
    expect(MAX).toBe(720);
    expect(DEFAULT).toBe(320);
  });

  it("passes through an in-range width unchanged", () => {
    expect(clampAgentFeedsWidth(500)).toBe(500);
    expect(clampAgentFeedsWidth(MIN)).toBe(MIN);
    expect(clampAgentFeedsWidth(MAX)).toBe(MAX);
    expect(clampAgentFeedsWidth(DEFAULT)).toBe(DEFAULT);
  });

  it("clamps below MIN up to MIN (never the default, never 0)", () => {
    expect(clampAgentFeedsWidth(261)).toBe(261);
    expect(clampAgentFeedsWidth(100)).toBe(MIN);
    expect(clampAgentFeedsWidth(MIN - 1)).toBe(MIN);
  });

  it("clamps above MAX down to MAX", () => {
    expect(clampAgentFeedsWidth(9999)).toBe(MAX);
    expect(clampAgentFeedsWidth(MAX + 1)).toBe(MAX);
  });

  it("falls back to the default for non-numeric / null / empty (unset storage)", () => {
    expect(clampAgentFeedsWidth(null)).toBe(DEFAULT);
    expect(clampAgentFeedsWidth(undefined)).toBe(DEFAULT);
    expect(clampAgentFeedsWidth("")).toBe(DEFAULT);
    expect(clampAgentFeedsWidth("garbage")).toBe(DEFAULT);
    expect(clampAgentFeedsWidth(NaN)).toBe(DEFAULT);
  });

  it("treats 0 and negatives as the default — width 0 is 'closed', a separate state", () => {
    expect(clampAgentFeedsWidth(0)).toBe(DEFAULT);
    expect(clampAgentFeedsWidth("0")).toBe(DEFAULT);
    expect(clampAgentFeedsWidth(-50)).toBe(DEFAULT);
  });

  it("parses a persisted px string the way localStorage hands it back", () => {
    // localStorage.setItem stores String(w); getItem returns that string.
    expect(clampAgentFeedsWidth("500")).toBe(500);
    expect(clampAgentFeedsWidth("300")).toBe(300);
  });
});

// NOT unit-tested here (irreducibly DOM/pointer glue): the pointerdown/move/up
// drag on .agent-feeds-resize-handle, setPointerCapture, the localStorage
// write on pointerup, dblclick-reset, and toggleAgentFeeds' Spring open/close.
// Those require a real pointer-event stream + layout; they're covered by
// node --check + the reconciliation reasoning in the chunk report.

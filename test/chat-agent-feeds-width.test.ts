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
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let clampAgentFeedsWidth: (w: unknown, max?: number) => number;
let agentFeedsMaxWidth: () => number;
let agentFeedsDefaultWidth: (tab: string, viewportWidth?: number, max?: number) => number;
let getAgentFeedsWidth: (tab?: string) => number;
let applyAgentFeedsTabWidth: (tab: string) => void;
let MIN: number, MAX: number, DEFAULT: number, CHAT_MIN: number;

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds-resize.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    src +
      "\nreturn { clampAgentFeedsWidth, agentFeedsMaxWidth, agentFeedsDefaultWidth," +
      " getAgentFeedsWidth, applyAgentFeedsTabWidth, AGENT_FEEDS_MIN, AGENT_FEEDS_MAX," +
      " AGENT_FEEDS_DEFAULT, CHAT_MIN_VISIBLE };"
  );
  const m = factory();
  clampAgentFeedsWidth = m.clampAgentFeedsWidth;
  agentFeedsMaxWidth = m.agentFeedsMaxWidth;
  agentFeedsDefaultWidth = m.agentFeedsDefaultWidth;
  getAgentFeedsWidth = m.getAgentFeedsWidth;
  applyAgentFeedsTabWidth = m.applyAgentFeedsTabWidth;
  MIN = m.AGENT_FEEDS_MIN;
  MAX = m.AGENT_FEEDS_MAX;
  DEFAULT = m.AGENT_FEEDS_DEFAULT;
  CHAT_MIN = m.CHAT_MIN_VISIBLE;
});

function setViewport(w: number): void {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
}

// happy-dom does no layout, so a real rect is always 0 — stub the one read.
function makeSidebar(width: number): HTMLElement {
  const el = document.createElement("div");
  el.id = "sidebar";
  el.getBoundingClientRect = (() => ({ width })) as unknown as HTMLElement["getBoundingClientRect"];
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.getElementById("sidebar")?.remove();
  document.getElementById("agent-feeds")?.remove();
  localStorage.clear();
});

describe("tab-aware right-panel defaults", () => {
  it("opens ordinary tabs near one-third width and Browser near two-thirds", () => {
    expect(agentFeedsDefaultWidth("agents", 1920, 1560)).toBe(634);
    expect(agentFeedsDefaultWidth("artifacts", 1920, 1560)).toBe(634);
    expect(agentFeedsDefaultWidth("terminal", 1920, 1560)).toBe(634);
    expect(agentFeedsDefaultWidth("browser", 1920, 1560)).toBe(1190);
  });

  it("keeps manual widths separate between Browser and ordinary tabs", () => {
    setViewport(1920);
    localStorage.setItem("lax_agent_feeds_width", "700");
    localStorage.setItem("lax_browser_panel_width", "1100");
    expect(getAgentFeedsWidth("agents")).toBe(700);
    expect(getAgentFeedsWidth("artifacts")).toBe(700);
    expect(getAgentFeedsWidth("browser")).toBe(1100);
  });

  it("resizes an open panel when its tab changes", () => {
    setViewport(1920);
    const panel = document.createElement("div");
    panel.id = "agent-feeds";
    document.body.appendChild(panel);
    applyAgentFeedsTabWidth("browser");
    expect(panel.style.width).toBe("1190px");
    applyAgentFeedsTabWidth("agents");
    expect(panel.style.width).toBe("634px");
  });
});

describe("clampAgentFeedsWidth (C7 right-rail resize)", () => {
  it("MIN is 260, the default is 320, and 720 is now only the no-viewport fallback", () => {
    expect(MIN).toBe(260);
    // Not a hard cap any more: the live ceiling is agentFeedsMaxWidth(), which
    // is viewport-derived so the BROWSER tab can run near-fullscreen.
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

// The panel used to be capped at a fixed 720px, which made a near-fullscreen
// BROWSER tab impossible on any large monitor. The ceiling is now derived from
// the viewport so the user can close the left pane, drag the browser out to
// nearly the whole window, and still have a chat column to talk to the agent in.
describe("agentFeedsMaxWidth (near-fullscreen browser ceiling)", () => {
  it("is the viewport minus the chat minimum when the nav sidebar is closed", () => {
    setViewport(1920);
    expect(agentFeedsMaxWidth()).toBe(1920 - CHAT_MIN);
    // Far past the old hard cap — the whole point of the change.
    expect(agentFeedsMaxWidth()).toBeGreaterThan(MAX);
  });

  it("reserves the nav sidebar while open, and hands that width over when it closes", () => {
    setViewport(1920);
    const sb = makeSidebar(240);
    expect(agentFeedsMaxWidth()).toBe(1920 - CHAT_MIN - 240);
    // Closing the left pane must immediately buy the browser that space.
    sb.classList.add("collapsed");
    expect(agentFeedsMaxWidth()).toBe(1920 - CHAT_MIN);
  });

  it("always leaves the chat column at least CHAT_MIN_VISIBLE", () => {
    setViewport(1600);
    expect(1600 - agentFeedsMaxWidth()).toBeGreaterThanOrEqual(CHAT_MIN);
  });

  it("never returns below MIN, even when the reserve exceeds the viewport", () => {
    // A narrow window: viewport - reserve would go negative and invert the clamp.
    setViewport(400);
    expect(agentFeedsMaxWidth()).toBe(MIN);
    setViewport(200);
    expect(agentFeedsMaxWidth()).toBe(MIN);
  });
});

describe("clampAgentFeedsWidth honours the injected ceiling", () => {
  it("allows widths far beyond the old 720 cap", () => {
    expect(clampAgentFeedsWidth(1560, 1560)).toBe(1560);
    expect(clampAgentFeedsWidth(1200, 1560)).toBe(1200);
    expect(clampAgentFeedsWidth(9999, 1560)).toBe(1560);
  });

  it("keeps the fallback default under a ceiling narrower than the default", () => {
    // Returning DEFAULT (320) against a 300 ceiling would overflow the layout.
    expect(clampAgentFeedsWidth(null, 300)).toBe(300);
    expect(clampAgentFeedsWidth("garbage", 300)).toBe(300);
  });

  it("a ceiling below MIN cannot invert the clamp", () => {
    expect(clampAgentFeedsWidth(500, 100)).toBe(MIN);
  });

  it("still uses the static fallback when no ceiling is passed", () => {
    expect(clampAgentFeedsWidth(9999)).toBe(MAX);
  });
});

// NOT unit-tested here (irreducibly DOM/pointer glue): the pointerdown/move/up
// drag on .agent-feeds-resize-handle, setPointerCapture, the localStorage
// write on pointerup, dblclick-reset, and toggleAgentFeeds' Spring open/close.
// Those require a real pointer-event stream + layout; they're covered by
// node --check + the reconciliation reasoning in the chunk report.

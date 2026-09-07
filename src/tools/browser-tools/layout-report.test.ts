/**
 * Behaviour of the `layout_report` action, driven end-to-end through the
 * tool's execute() so the gate pipeline (sensitive page → human verification
 * → dispatch → progress guard) is exercised, not bypassed.
 *
 * Mocked at the BACKEND boundary only: no real browser, no real page. The
 * script's own measuring and read-only behaviour are proven against a real
 * DOM in test/browser-layout-report-script.test.ts.
 *
 * The property under test here is STRUCTURAL: the handler adds exactly one
 * neutral preamble line over the raw JSON and never a verdict. Three prior
 * rounds put a summary sentence over the data and each was false for some
 * partially-complete report (revert 55cea840) — so the strongest assertion
 * in this file is that a clean report and a truncated report get the SAME
 * preamble, byte for byte.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  manager: {} as Record<string, unknown>,
  blockedPattern: null as string | null,
}));

vi.mock("../../browser/index.js", () => ({
  getBrowserManager: () => seam.manager,
  closeBrowser: vi.fn(async () => {}),
  withBrowserLock: (_sid: string, fn: () => Promise<unknown>) => fn(),
  resetWedgedBrowser: vi.fn(async () => "recovered-in-place"),
  BrowserWedgeError: class BrowserWedgeError extends Error {},
}));
vi.mock("../../browser/guards.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/guards.js")>();
  return {
    ...actual,
    scanEvaluateScript: (script: string) => seam.blockedPattern ?? actual.scanEvaluateScript(script),
  };
});

import { createBrowserTools } from "./index.js";
import { LAYOUT_REPORT_FLAGS_SENTENCE } from "./layout-report.js";
import { scanEvaluateScript } from "../../browser/guards.js";
import { LAYOUT_REPORT_KNOWN_GAPS, LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { EMULATION_PRESETS, _resetSessionEmulationForTest, setSessionEmulation } from "../../browser/emulation.js";

const SESSION = "layout-session";
const PAGE = "https://shop.example.com/products";

const CLEAN_REPORT = {
  url: PAGE,
  viewport: { clientWidth: 390, clientHeight: 844, innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, userAgent: "iPhone", maxTouchPoints: 5 },
  documentScroll: { scrollWidth: 390, clientWidth: 390, horizontalOverflowPx: 0, scrollHeight: 2400, clientHeight: 844 },
  overflowingElements: [],
  overflowingElementsTotal: 0,
  overflowingElementsListed: 0,
  fixedAndStickyElements: [],
  fixedAndStickyTotal: 0,
  matchingMediaQueries: ["(max-width: 767px)"],
  matchingMediaQueriesTotal: 1,
  unreadableStyleSheets: 0,
  cssRulesTruncated: false,
  cssDepthTruncated: false,
  openShadowRoots: 0,
  iframes: 0,
  cssWalkIncomplete: null,
  elementScanIncomplete: null,
  elementsScanned: 312,
  scanTruncated: false,
  knownGaps: LAYOUT_REPORT_KNOWN_GAPS,
};

/** The scan walked only the first 4000 nodes and the CSS came from a CDN:
 *  every count in it is a floor. The handler must treat it EXACTLY like the
 *  clean one — the flags are in the JSON, and that is where they stay. */
const TRUNCATED_REPORT = {
  ...CLEAN_REPORT,
  matchingMediaQueries: [],
  matchingMediaQueriesTotal: 0,
  unreadableStyleSheets: 6,
  elementsScanned: 4000,
  scanTruncated: true,
  cssWalkIncomplete: "6 stylesheet(s) could not be read; element scan capped before all shadow roots/iframes could be visited",
  elementScanIncomplete: "the element scan stopped after 4000 nodes (its cap), so nothing later in the document was measured",
};

/** Sentences no output may contain: each is a verdict a truncated scan could
 *  make false, and each was shipped by a prior round. */
const VERDICT_PATTERNS = [
  /Horizontal overflow/i,
  /extend past the viewport/i,
  /matching @media quer/i,
  /fixed\/sticky element\(s\)/i,
  /\bat least \d/i,
  /INCOMPLETE:/,
  /LOWER BOUNDS?\. /,
  /Full report:/,
];

function tool() {
  const [browser] = createBrowserTools(() => SESSION);
  return browser;
}

async function runReport(report: unknown): Promise<string> {
  seam.manager.evaluate = vi.fn(async () => JSON.stringify(report, null, 2));
  const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });
  expect(result.isError).not.toBe(true);
  return String(result.content);
}

beforeEach(() => {
  _resetSessionEmulationForTest();
  for (const k of Object.keys(seam.manager)) delete seam.manager[k];
  seam.blockedPattern = null;
  seam.manager.getCurrentUrl = () => PAGE;
  seam.manager.observe = vi.fn(async () => ({ title: "Products", url: PAGE, currentRefs: [], crossOriginIframes: [] }));
});

describe("browser layout_report", () => {
  it("emits ONE neutral preamble line — URL and the flags sentence — then the JSON in the untrusted wrapper", async () => {
    const text = await runReport(CLEAN_REPORT);
    const [preamble, blank, wrapperOpen] = text.split("\n");

    expect(preamble).toBe(`Layout report for ${PAGE}. ${LAYOUT_REPORT_FLAGS_SENTENCE}`);
    expect(blank).toBe("");
    expect(wrapperOpen).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT id=/);
    expect(text).toContain("source: browser.layout_report");
    // The data is passed through, not re-rendered.
    expect(text).toContain('"horizontalOverflowPx": 0');
    expect(text).toContain('"(max-width: 767px)"');
    expect(text).toContain('"knownGaps"');
  });

  it("states no verdict on a clean report", async () => {
    const text = await runReport(CLEAN_REPORT);
    for (const pattern of VERDICT_PATTERNS) expect(text).not.toMatch(pattern);
  });

  it("states no verdict on a truncated report either — the preamble is byte-identical to the clean one", async () => {
    const clean = await runReport(CLEAN_REPORT);
    const truncated = await runReport(TRUNCATED_REPORT);

    expect(truncated.split("\n")[0]).toBe(clean.split("\n")[0]);
    for (const pattern of VERDICT_PATTERNS) expect(truncated).not.toMatch(pattern);
    // The flags travel in the JSON, untouched.
    expect(truncated).toContain('"scanTruncated": true');
    expect(truncated).toContain("element scan capped before all shadow roots/iframes could be visited");
  });

  it("names the session's installed emulation profile in the preamble, and the JSON viewport stays the measured one", async () => {
    setSessionEmulation(SESSION, EMULATION_PRESETS.iphone);

    const text = await runReport({ ...CLEAN_REPORT, viewport: { ...CLEAN_REPORT.viewport, clientWidth: 1280 } });
    const preamble = text.split("\n")[0];

    expect(preamble).toContain("Emulation profile installed on this session's browser: 390x844 @3x");
    expect(preamble).toMatch(/isMobile=true, hasTouch=true; User-Agent: .*iPhone/);
    expect(preamble).toContain(LAYOUT_REPORT_FLAGS_SENTENCE);
    // No reconciliation: the profile says 390, the page measured 1280, both are printed.
    expect(text).toContain('"clientWidth": 1280');
    expect(preamble).not.toMatch(/1280/);
  });

  it("does not parse or reshape the page's result — an unexpected shape is passed through as-is", async () => {
    seam.manager.evaluate = vi.fn(async () => "not json at all");

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });
    const text = String(result.content);

    expect(result.isError).not.toBe(true);
    expect(text.split("\n")[0]).toBe(`Layout report for ${PAGE}. ${LAYOUT_REPORT_FLAGS_SENTENCE}`);
    expect(text).toContain("not json at all");
    for (const pattern of VERDICT_PATTERNS) expect(text).not.toMatch(pattern);
  });

  it("never drives a mutating backend operation — one evaluate, nothing else", async () => {
    const evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));
    seam.manager.evaluate = evaluate;
    const mutators = ["click", "clickByRef", "clickByText", "fill", "fillByRef", "select", "scroll", "navigate", "newTab", "dialogAccept", "dialogDismiss"];
    for (const method of mutators) {
      seam.manager[method] = vi.fn(async () => { throw new Error(`layout_report must not call ${method}`); });
    }

    await tool().execute({ action: "layout_report", _sessionId: SESSION });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(LAYOUT_REPORT_SCRIPT);
    for (const method of mutators) expect(seam.manager[method]).not.toHaveBeenCalled();
  });

  // Only the in-app backend scans evaluate text internally; BrowserManager
  // (external Chrome) hands it straight to the page. The handler therefore
  // scans its own script before evaluate on BOTH paths.
  it("runs the evaluate blocklist over its own script before evaluate, and refuses on a trip", async () => {
    seam.manager.evaluate = vi.fn(async () => JSON.stringify(CLEAN_REPORT));
    seam.blockedPattern = "some-blocked-pattern";

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });

    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/rejected by the evaluate blocklist/i);
    expect(String(result.content)).toContain("some-blocked-pattern");
    expect(seam.manager.evaluate).not.toHaveBeenCalled();
  });

  it("and the real script clears that blocklist, so nothing had to be relaxed for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });
});

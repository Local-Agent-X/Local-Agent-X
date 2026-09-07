/**
 * Behaviour of the `layout_report` action, driven end-to-end through the
 * tool's execute() so the gate pipeline (sensitive page → human verification
 * → dispatch → progress guard) is exercised, not bypassed.
 *
 * Mocked at the BACKEND boundary only: no real browser, no real page. The
 * script's own measuring, sizing and read-only behaviour are proven against a
 * real DOM in test/browser-layout-report-script.test.ts.
 *
 * The property under test here is STRUCTURAL: the handler adds one preamble
 * line naming the page and nothing else — no verdict, no flags sentence, no
 * emulation profile — and the bytes of that line are the same for a clean
 * report, a truncated report, and a session with a profile installed.
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
import { layoutReportPreamble } from "./layout-report.js";
import { scanEvaluateScript } from "../../browser/guards.js";
import { LAYOUT_REPORT_KNOWN_GAPS, LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { EMULATION_PRESETS, _resetSessionEmulationForTest, setSessionEmulation } from "../../browser/emulation.js";

const SESSION = "layout-session";
const PAGE = "https://shop.example.com/products";
const PREAMBLE = `Layout report for ${PAGE}.`;

const CLEAN_REPORT = {
  url: PAGE,
  viewport: { clientWidth: 390, clientHeight: 844, innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, userAgent: "iPhone", maxTouchPoints: 5 },
  documentScroll: { scrollWidth: 390, clientWidth: 390, horizontalOverflowPx: 0, scrollHeight: 2400, clientHeight: 844 },
  listsTrimmedForSize: false,
  overflowingElementsTotal: 0,
  overflowingElementsListed: 0,
  fixedAndStickyTotal: 0,
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
  overflowingElements: [],
  fixedAndStickyElements: [],
  matchingMediaQueries: ["(max-width: 767px)"],
};

/** The scan walked only the first 4000 nodes and the CSS came from a CDN:
 *  the counts in it are floors. The handler must treat it like the clean
 *  one — the flags are in the JSON, and that is where they stay. */
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

/** Sentences no output may contain: each is a claim a truncated scan or a
 *  re-minted context could make false, and each was shipped by a prior round. */
const VERDICT_PATTERNS = [
  /Horizontal overflow/i,
  /extend past the viewport/i,
  /matching @media quer/i,
  /fixed\/sticky element\(s\)/i,
  /\bat least \d/i,
  /INCOMPLETE:/,
  /LOWER BOUNDS?\. /,
  /Full report:/,
  /Completeness flags/i,
  /Emulation profile/i,
];

function tool() {
  const [browser] = createBrowserTools(() => SESSION);
  return browser;
}

/** The page script returns compact JSON (one line); the mock does the same. */
async function runReport(report: unknown): Promise<string> {
  seam.manager.evaluate = vi.fn(async () => JSON.stringify(report));
  const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });
  expect(result.isError).not.toBe(true);
  return String(result.content);
}

/** The bytes inside the untrusted-content wrapper's <content> block. */
function payload(text: string): string {
  const lines = text.split("\n");
  const open = lines.indexOf("<content>");
  const close = lines.indexOf("</content>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return lines.slice(open + 1, close).join("\n").trim();
}

beforeEach(() => {
  _resetSessionEmulationForTest();
  for (const k of Object.keys(seam.manager)) delete seam.manager[k];
  seam.blockedPattern = null;
  seam.manager.getCurrentUrl = () => PAGE;
  seam.manager.observe = vi.fn(async () => ({ title: "Products", url: PAGE, currentRefs: [], crossOriginIframes: [] }));
});

describe("browser layout_report", () => {
  it("emits exactly `Layout report for <url>.`, a blank line, then the JSON in the untrusted wrapper", async () => {
    const text = await runReport(CLEAN_REPORT);
    const [preamble, blank, wrapperOpen] = text.split("\n");

    expect(preamble).toBe(PREAMBLE);
    expect(blank).toBe("");
    expect(wrapperOpen).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT id=/);
    expect(text).toContain("source: browser.layout_report");
  });

  it("passes the JSON through: the payload parses back to the report the page returned", async () => {
    const text = await runReport(CLEAN_REPORT);

    expect(JSON.parse(payload(text))).toEqual(CLEAN_REPORT);
  });

  it("uses the current-page wording when the backend has no URL", () => {
    expect(layoutReportPreamble("")).toBe("Layout report for the current page.");
    expect(layoutReportPreamble(PAGE)).toBe(PREAMBLE);
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
    expect(JSON.parse(payload(truncated))).toEqual(TRUNCATED_REPORT);
  });

  it("prints no emulation profile even when one is installed on the session — the JSON viewport is the measurement", async () => {
    setSessionEmulation(SESSION, EMULATION_PRESETS.iphone);

    const text = await runReport({ ...CLEAN_REPORT, viewport: { ...CLEAN_REPORT.viewport, clientWidth: 1280 } });
    const preamble = text.split("\n")[0];

    expect(preamble).toBe(PREAMBLE);
    expect(text).not.toMatch(/390x844|isMobile|hasTouch|User-Agent/);
    expect(text).toContain('"clientWidth":1280');
  });

  it("does not parse or reshape the page's result — an unexpected shape is passed through as-is", async () => {
    seam.manager.evaluate = vi.fn(async () => "not json at all");

    const result = await tool().execute({ action: "layout_report", _sessionId: SESSION });
    const text = String(result.content);

    expect(result.isError).not.toBe(true);
    expect(text.split("\n")[0]).toBe(PREAMBLE);
    expect(text).toContain("not json at all");
    for (const pattern of VERDICT_PATTERNS) expect(text).not.toMatch(pattern);
  });

  it("drives no mutating backend operation — one evaluate, nothing else", async () => {
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

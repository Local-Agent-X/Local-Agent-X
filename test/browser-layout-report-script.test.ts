// @vitest-environment happy-dom
/**
 * The layout diagnostic script, run against a REAL DOM.
 *
 * Proven here, which a mocked backend cannot show:
 *   1. it measures — an element wider than the viewport is found and named;
 *   2. the counted early returns / catches in its walks that the "silent skip"
 *      blocks below enumerate each move a counter that feeds a flag;
 *   3. a capped ELEMENT scan also flags the CSS walk, because shadow-root and
 *      iframe sheet discovery lives inside the element loop;
 *   4. the known gaps are stated on a clean report;
 *   5. the compact JSON survives page-ops' evaluate truncation with its flags
 *      intact (the real evaluateScript, not a mock);
 *   6. it does not mutate the state that observableState() enumerates, and
 *      the ESCAPES table shows that harness going red for the listed escapes.
 *
 * happy-dom does no layout, so rects come from a per-element `data-rect`
 * attribute (same approach as browser-extract-stable-ids.test.ts).
 * Lives under test/ because the root tsconfig compiles src/ without the DOM lib.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  LAYOUT_REPORT_KNOWN_GAPS, LAYOUT_REPORT_LIST_CAP, LAYOUT_REPORT_MAX_CHARS, LAYOUT_REPORT_RULE_DEPTH,
  LAYOUT_REPORT_SCAN_CAP, LAYOUT_REPORT_SCRIPT,
} from "../src/browser/layout-report.js";
import { evaluateScript } from "../src/browser/page-ops.js";
import { MAX_TEXT_LENGTH } from "../src/browser/launcher.js";
import { scanEvaluateScript } from "../src/browser/guards.js";
import { evaluateMutationReason } from "../src/tools/browser-tools/page.js";

const VIEWPORT = 390;

interface LayoutReport {
  matchingMediaQueries: string[];
  matchingMediaQueriesTotal: number;
  matchingMediaQueriesListed: number;
  unreadableStyleSheets: number;
  unreadableRules: number;
  unloadedImports: number;
  unevaluableMediaConditions: number;
  cssRulesTruncated: boolean;
  cssDepthTruncated: boolean;
  cssWalkIncomplete: string | null;
  elementScanIncomplete: string | null;
  openShadowRoots: number;
  iframes: number;
  sameOriginIframes: number;
  styleSheetsWalked: number;
  adoptedStyleSheets: number;
  shadowRootStyleSheets: number;
  documentScroll: { scrollWidth: number; clientWidth: number; horizontalOverflowPx: number };
  overflowingElements: { selector: string; overflowRightPx: number; backgroundColor: string }[];
  overflowingElementsTotal: number;
  overflowingElementsListed: number;
  fixedAndStickyElements: { selector: string; position: string }[];
  fixedAndStickyTotal: number;
  fixedAndStickyListed: number;
  backgrounds: { html: string; body: string; canvas: string };
  viewport: { clientWidth: number };
  elementsScanned: number;
  scanTruncated: boolean;
  hiddenElementsSkipped: number;
  zeroSizeElementsSkipped: number;
  listCap: number;
  listsTrimmedForSize: boolean;
  knownGaps: string[];
}

/** Flags and totals a reader needs before trusting any count. A serialization
 *  that lost one of these is the F1 failure. */
const FLAG_KEYS = [
  "listsTrimmedForSize", "overflowingElementsTotal", "overflowingElementsListed", "fixedAndStickyTotal",
  "fixedAndStickyListed", "matchingMediaQueriesTotal", "matchingMediaQueriesListed", "unreadableStyleSheets",
  "unreadableRules", "unloadedImports", "unevaluableMediaConditions", "cssRulesTruncated", "cssDepthTruncated",
  "cssWalkIncomplete", "elementsScanned", "scanTruncated", "hiddenElementsSkipped", "zeroSizeElementsSkipped",
  "openShadowRoots", "iframes", "sameOriginIframes", "elementScanIncomplete", "knownGaps",
] as const;
const LIST_KEYS = ["overflowingElements", "fixedAndStickyElements", "matchingMediaQueries"] as const;

function box(el: Element): DOMRect {
  const raw = (el as HTMLElement).dataset?.rect;
  const [x, y, width, height] = raw ? raw.split(",").map(Number) : [0, 0, 100, 20];
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect;
}

/** The script returns a compact JSON STRING (so page-ops does not pretty-print
 *  it); the tests parse it. */
function runRaw(script: string): string {
  return new Function(`return ${script}`)() as string;
}
function runScript(script: string): LayoutReport {
  return JSON.parse(runRaw(script)) as LayoutReport;
}
const run = (): LayoutReport => runScript(LAYOUT_REPORT_SCRIPT);

const media = (mediaText: string, children: unknown[] = []) => ({ media: { mediaText }, cssRules: children });
/** @layer / @supports: a grouping rule with children and NO .media. */
const group = (children: unknown[]) => ({ cssRules: children });

/** The rules are stubbed rather than parsed: happy-dom's CSSOM does not build
 *  nested grouping rules, and what is under test is the WALK, not a parser. */
function withSheets(sheets: unknown[], matches: string[], matchMediaImpl?: (q: string) => { matches: boolean; media: string }): LayoutReport {
  Object.defineProperty(document, "styleSheets", { value: sheets, configurable: true });
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (matchMediaImpl ?? ((q: string) => ({ matches: matches.includes(q), media: q }))) as typeof matchMedia;
  try { return run(); } finally { globalThis.matchMedia = previous; restoreSheetProperties(); }
}

/** Drops the own-property stubs the sheet tests install, so the prototype
 *  getters are back for whatever runs next. */
function restoreSheetProperties(): void {
  delete (document as unknown as Record<string, unknown>).styleSheets;
  delete (document as unknown as Record<string, unknown>).adoptedStyleSheets;
}

beforeEach(() => {
  restoreSheetProperties();
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.adoptedStyleSheets = [];
  Element.prototype.getBoundingClientRect = function () { return box(this); };
  for (const [prop, value] of [["clientWidth", VIEWPORT], ["clientHeight", 844]] as const) {
    Object.defineProperty(document.documentElement, prop, { value, configurable: true });
  }
});

describe("layout_report script measures", () => {
  it("finds the element that overflows the viewport and names it", () => {
    document.body.innerHTML =
      `<div id="promo-strip" data-rect="0,0,427,32" style="background-color: rgb(221, 221, 221)">Free shipping</div>` +
      `<p data-rect="0,40,390,20">In-bounds copy</p>`;
    Object.defineProperty(document.documentElement, "scrollWidth", { value: 427, configurable: true });

    const report = run();

    expect(report.documentScroll.horizontalOverflowPx).toBe(427 - VIEWPORT);
    expect(report.overflowingElementsTotal).toBe(1);
    expect(report.overflowingElements[0].selector).toBe("div#promo-strip");
    expect(report.overflowingElements[0].overflowRightPx).toBe(37);
    expect(report.overflowingElements[0].backgroundColor).toContain("221");
  });

  it("reports zero overflow, with the flags clear, for a page that fits", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">Fits exactly</p>`;
    Object.defineProperty(document.documentElement, "scrollWidth", { value: VIEWPORT, configurable: true });

    const report = run();

    expect(report.documentScroll.horizontalOverflowPx).toBe(0);
    expect(report.overflowingElements).toEqual([]);
    expect(report.overflowingElementsTotal).toBe(0);
    expect(report.cssWalkIncomplete).toBeNull();
    expect(report.elementScanIncomplete).toBeNull();
    expect(report.scanTruncated).toBe(false);
    expect(report.listsTrimmedForSize).toBe(false);
  });

  it("reports the geometry of fixed and sticky furniture", () => {
    document.body.innerHTML =
      `<div data-rect="0,0,390,24" style="position: sticky">Announcement</div>` +
      `<nav class="site-nav" data-rect="0,24,390,56" style="position: fixed">Home</nav>` +
      `<p data-rect="0,90,390,20">Body</p>`;

    const report = run();

    expect(report.fixedAndStickyTotal).toBe(2);
    expect(report.fixedAndStickyElements.map((e) => e.position)).toEqual(["sticky", "fixed"]);
    expect(report.fixedAndStickyElements[1].selector).toBe("nav.site-nav");
  });

  it("lists a 1px and a sub-pixel overflow — there is no tolerance beyond 2-decimal rounding", () => {
    document.body.innerHTML =
      `<div id="one" data-rect="0,0,391,20">one px</div>` +
      `<div id="frac" data-rect="0,20,390.4,20">fraction</div>` +
      `<div id="dust" data-rect="0,40,390.004,20">rounds to zero</div>`;

    const report = run();

    expect(report.overflowingElements.map((e) => [e.selector, e.overflowRightPx])).toEqual([["div#one", 1], ["div#frac", 0.4]]);
    expect(report.overflowingElementsTotal).toBe(2);
  });

  it("counts, and does not list, an element whose rect is zero-size", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">shown</p>`;
    const baseline = run().zeroSizeElementsSkipped;

    document.body.innerHTML = `<span id="anchor" data-rect="1000,0,0,0"></span><p data-rect="0,0,390,20">shown</p>`;
    const report = run();

    expect(report.zeroSizeElementsSkipped).toBe(baseline + 1);
    expect(report.overflowingElementsTotal).toBe(0);
  });

  it("elementsScanned is the number of elements in the document, not the cap", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">a</p><p data-rect="0,20,390,20">b</p>`;

    expect(run().elementsScanned).toBe(document.querySelectorAll("*").length);
  });
});

describe("known gaps are stated unconditionally", () => {
  it("lists @container and closed shadow roots on a clean report", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">plain</p>`;

    const report = run();

    expect(report.cssWalkIncomplete).toBeNull();
    expect(report.elementScanIncomplete).toBeNull();
    expect(report.knownGaps).toEqual([...LAYOUT_REPORT_KNOWN_GAPS]);
    expect(report.knownGaps.some((g) => /@container/.test(g))).toBe(true);
    expect(report.knownGaps.some((g) => /closed shadow roots are not detectable/i.test(g))).toBe(true);
    expect(report.knownGaps.some((g) => /open shadow roots and inside iframe documents are not measured/i.test(g))).toBe(true);
  });
});

/**
 * F1 — the output must survive page-ops.evaluateScript, which pretty-prints
 * non-string results and hard-truncates at MAX_TEXT_LENGTH. Run through the
 * REAL evaluateScript against a fake Page whose evaluate() is happy-dom eval.
 */
describe("layout_report output survives the evaluate path", () => {
  const page = { evaluate: async (expression: string) => (0, eval)(expression) } as unknown as Page;
  const overflowRows = (n: number, textLen = 5): string =>
    Array.from({ length: n }, (_, i) =>
      `<div class="promo-strip-row-${i} banner-full-bleed" data-rect="0,${i * 20},${500 + i},20">${"x".repeat(textLen)}</div>`).join("");

  it("compact JSON, flags before lists, under the evaluate cap at 200 rows through the real evaluateScript", async () => {
    expect(LAYOUT_REPORT_MAX_CHARS).toBeLessThan(MAX_TEXT_LENGTH);
    document.body.innerHTML = overflowRows(200, 60);

    const text = await evaluateScript(page, LAYOUT_REPORT_SCRIPT);

    expect(text).not.toContain("[Truncated at");
    expect(text.length).toBeLessThan(MAX_TEXT_LENGTH);
    expect(text.length).toBeLessThanOrEqual(LAYOUT_REPORT_MAX_CHARS);
    expect(text).not.toContain("\n");
    const report = JSON.parse(text) as LayoutReport;
    for (const key of FLAG_KEYS) expect(report).toHaveProperty(key);
    expect(report.overflowingElementsTotal).toBe(200);
    expect(report.overflowingElementsListed).toBe(report.overflowingElements.length);
    expect(report.overflowingElements.length).toBeLessThanOrEqual(LAYOUT_REPORT_LIST_CAP);
  });

  it("orders scalars and flags before knownGaps and the lists", () => {
    document.body.innerHTML = overflowRows(3);
    const keys = Object.keys(JSON.parse(runRaw(LAYOUT_REPORT_SCRIPT)) as object);
    const firstList = Math.min(...LIST_KEYS.map((k) => keys.indexOf(k)));

    expect(firstList).toBeGreaterThan(-1);
    for (const key of FLAG_KEYS) expect(keys.indexOf(key)).toBeLessThan(firstList);
    expect(keys.indexOf("knownGaps")).toBe(firstList - 1);
  });

  it("trims list rows from the tail, in order, to fit the budget, and says so", () => {
    // 20 long-labelled rows exceed the budget; the trim drops rows (not flags)
    // and records the retained count. Totals stay at the measured value.
    document.body.innerHTML = overflowRows(200, 200) + `<nav data-rect="0,0,390,56" style="position: fixed">Home</nav>`;

    const text = runRaw(LAYOUT_REPORT_SCRIPT);
    const report = JSON.parse(text) as LayoutReport;

    expect(text.length).toBeLessThanOrEqual(LAYOUT_REPORT_MAX_CHARS);
    expect(report.listsTrimmedForSize).toBe(true);
    expect(report.overflowingElementsTotal).toBe(200);
    expect(report.overflowingElementsListed).toBeLessThan(LAYOUT_REPORT_LIST_CAP);
    expect(report.overflowingElementsListed).toBe(report.overflowingElements.length);
    // The worst offenders are kept: the tail (smallest overflow) is what went.
    expect(report.overflowingElements[0].overflowRightPx).toBe(500 + 199 - VIEWPORT);
    // Overflowing rows go before fixed/sticky rows.
    expect(report.fixedAndStickyListed).toBe(1);
    expect(report.fixedAndStickyElements).toHaveLength(1);
  });

  it("does not trim a report that fits", () => {
    document.body.innerHTML = overflowRows(20);
    const report = JSON.parse(runRaw(LAYOUT_REPORT_SCRIPT)) as LayoutReport;

    expect(report.listsTrimmedForSize).toBe(false);
    expect(report.overflowingElementsListed).toBe(LAYOUT_REPORT_LIST_CAP);
  });
});

/** One test per counted early return / catch that can lose a rule or a sheet. */
describe("counted silent skips in the CSS walk", () => {
  it("finds an @media nested inside @layer > @supports, and inside another @media", () => {
    const report = withSheets(
      [group([group([media("(max-width: 767px)", [media("(orientation: portrait)")])])]), group([media("print")])],
      ["(max-width: 767px)", "(orientation: portrait)"],
    );

    expect(report.matchingMediaQueries.sort()).toEqual(["(max-width: 767px)", "(orientation: portrait)"]);
    expect(report.matchingMediaQueries).not.toContain("print");
    expect(report.cssWalkIncomplete).toBeNull();
  });

  it("counts a repeated matching condition once, in the list and in the total", () => {
    const report = withSheets(
      [group([media("(max-width: 767px)"), media("(max-width: 767px)")]), group([media("(max-width: 767px)")])],
      ["(max-width: 767px)"],
    );

    expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
    expect(report.matchingMediaQueriesTotal).toBe(1);
    expect(report.matchingMediaQueriesListed).toBe(1);
  });

  it("a sheet whose cssRules THROWS (cross-origin) is counted", () => {
    const cdn = { get cssRules(): unknown { throw new Error("SecurityError: cross-origin stylesheet"); } };
    const report = withSheets([cdn, group([media("(max-width: 767px)")])], ["(max-width: 767px)"]);

    expect(report.unreadableStyleSheets).toBe(1);
    expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
    expect(report.cssWalkIncomplete).toMatch(/1 stylesheet\(s\) could not be read/);
  });

  it("a sheet whose cssRules is NULL without throwing is counted, not skipped", () => {
    const report = withSheets([{ cssRules: null }], []);

    expect(report.unreadableStyleSheets).toBe(1);
    expect(report.cssWalkIncomplete).toMatch(/1 stylesheet\(s\) could not be read/);
  });

  it("a null entry in a stylesheet list is counted", () => {
    const report = withSheets([null, group([media("(max-width: 767px)")])], ["(max-width: 767px)"]);

    expect(report.unreadableStyleSheets).toBe(1);
    expect(report.styleSheetsWalked).toBe(1);
    expect(report.cssWalkIncomplete).not.toBeNull();
  });

  it("an @import whose stylesheet has not loaded is counted", () => {
    const report = withSheets([group([{ href: "https://cdn.example.com/theme.css", styleSheet: null }])], []);

    expect(report.unloadedImports).toBe(1);
    expect(report.cssWalkIncomplete).toMatch(/1 @import rule\(s\) had no loaded stylesheet/);
  });

  it("an @import whose loaded sheet IS readable is walked, with no flag", () => {
    const report = withSheets(
      [group([{ href: "https://same.example.com/theme.css", styleSheet: { cssRules: [media("(max-width: 767px)")] } }])],
      ["(max-width: 767px)"],
    );

    expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
    expect(report.unloadedImports).toBe(0);
    expect(report.cssWalkIncomplete).toBeNull();
  });

  it("an @import's own media condition (`@import url() (max-width: 600px)`) is evaluated, loaded or not", () => {
    const loaded = { href: "https://same.example.com/a.css", styleSheet: { cssRules: [] }, media: { mediaText: "(max-width: 600px)" } };
    const pending = { href: "https://cdn.example.com/b.css", styleSheet: null, media: { mediaText: "(orientation: portrait)" } };
    const report = withSheets([group([loaded, pending])], ["(max-width: 600px)", "(orientation: portrait)"]);

    expect(report.matchingMediaQueries.sort()).toEqual(["(max-width: 600px)", "(orientation: portrait)"]);
    expect(report.unloadedImports).toBe(1);
  });

  it("an @import whose loaded sheet throws on cssRules is counted as an unreadable rule", () => {
    const crossOrigin = { href: "https://cdn.example.com/theme.css", styleSheet: { get cssRules(): unknown { throw new Error("SecurityError"); } } };
    const report = withSheets([group([crossOrigin])], []);

    expect(report.unreadableRules).toBe(1);
    expect(report.cssWalkIncomplete).toMatch(/1 rule\(s\) could not be read/);
  });

  it("a null entry in a rule list is counted", () => {
    const report = withSheets([group([null, media("(max-width: 767px)")])], ["(max-width: 767px)"]);

    expect(report.unreadableRules).toBe(1);
    expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
    expect(report.cssWalkIncomplete).toMatch(/1 rule\(s\) could not be read/);
  });

  it("a media condition matchMedia refuses to evaluate is counted", () => {
    const report = withSheets([group([media("(bogus")])], [], () => { throw new Error("SyntaxError"); });

    expect(report.unevaluableMediaConditions).toBe(1);
    expect(report.cssWalkIncomplete).toMatch(/1 media condition\(s\) could not be evaluated/);
  });

  it("bounds the walk by DEPTH and says so — only when a non-empty list sat below the cap", () => {
    const nest = (leaf: unknown, depth: number): unknown => {
      let node = leaf;
      for (let i = 0; i < depth; i++) node = group([node]);
      return node;
    };
    // The outermost group is the sheet (depth 0 holds its children), so a
    // leaf under RULE_DEPTH+2 groups is the first one past the cap.
    const past = LAYOUT_REPORT_RULE_DEPTH + 2;
    expect(withSheets([nest(media("(max-width: 1px)"), past - 1)], ["(max-width: 1px)"]).cssDepthTruncated).toBe(false);
    const skipped = withSheets([nest(media("(max-width: 1px)"), past)], ["(max-width: 1px)"]);
    expect(skipped.matchingMediaQueries).toEqual([]);
    expect(skipped.cssDepthTruncated).toBe(true);
    expect(skipped.cssWalkIncomplete).toMatch(/nesting-depth cap/);
    expect(skipped.cssWalkIncomplete).toMatch(/rules below those points were skipped/);

    // A rule AT the cap whose child list is EMPTY (a plain style rule in
    // Chromium carries an empty cssRules) skipped nothing, so nothing is
    // flagged; the pre-fix walk recursed into the empty list and tripped.
    const empty = withSheets([nest(group([]), past - 1)], []);
    expect(empty.cssDepthTruncated).toBe(false);
    expect(empty.cssWalkIncomplete).toBeNull();
  });

  it("bounds the walk by rule COUNT and says so — and only when rules were actually skipped", () => {
    const wide = group(Array.from({ length: 25000 }, () => group([])));
    expect(withSheets([wide], []).cssRulesTruncated).toBe(true);
    expect(withSheets([wide], []).cssWalkIncomplete).toMatch(/hit its cap of \d+ rules/);

    // Exactly the budget: nothing was skipped, so nothing is flagged.
    const exact = group(Array.from({ length: 20000 - 1 }, () => group([])));
    expect(withSheets([exact], []).cssRulesTruncated).toBe(false);
  });

  it("walks document.adoptedStyleSheets, not only document.styleSheets", () => {
    Object.defineProperty(document, "adoptedStyleSheets", { value: [group([media("(max-width: 500px)")])], configurable: true, writable: true });
    const report = withSheets([], ["(max-width: 500px)"]);

    expect(report.matchingMediaQueries).toEqual(["(max-width: 500px)"]);
    expect(report.adoptedStyleSheets).toBe(1);
    expect(report.cssWalkIncomplete).toBeNull();
  });
});

describe("counted silent skips in the element scan", () => {
  it("counts display:none / visibility:hidden elements it did not measure", () => {
    // Baseline first: happy-dom's <head> is itself display:none, so the count
    // is asserted relative to a page with no hidden content of its own.
    document.body.innerHTML = `<p data-rect="0,0,390,20">shown</p>`;
    const baseline = run().hiddenElementsSkipped;

    document.body.innerHTML =
      `<div style="display:none" data-rect="0,0,900,20">gone</div>` +
      `<div style="visibility:hidden" data-rect="0,0,900,20">invisible but wide</div>` +
      `<p data-rect="0,0,390,20">shown</p>`;

    const report = run();

    expect(report.hiddenElementsSkipped).toBe(baseline + 2);
    expect(report.overflowingElementsTotal).toBe(0);
  });

  it("counts open shadow roots and iframes and flags both the element and CSS walks", () => {
    document.body.innerHTML =
      `<div id="host" data-rect="0,0,390,20"></div><iframe id="frame" data-rect="0,20,390,100"></iframe>`;
    const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
    root.innerHTML = `<div data-rect="0,0,900,20">wide inside the component</div>`;

    const report = run();

    expect(report.openShadowRoots).toBe(1);
    expect(report.iframes).toBe(1);
    // The wide element inside the shadow root is NOT in the count — that is
    // the limit, and the flag is what makes the zero safe to read.
    expect(report.overflowingElementsTotal).toBe(0);
    expect(report.elementScanIncomplete).toMatch(/does not pierce shadow DOM/);
    expect(report.elementScanIncomplete).toMatch(/1 iframe\(s\)/);
    expect(report.cssWalkIncomplete).toMatch(/iframe\(s\) are on the page/);
  });

  it("distinguishes same-origin iframes (contentDocument readable) from cross-origin ones (it throws)", () => {
    document.body.innerHTML =
      `<iframe id="same" data-rect="0,0,390,100"></iframe><iframe id="cross" data-rect="0,100,390,100"></iframe>`;
    Object.defineProperty(document.getElementById("cross"), "contentDocument", {
      get() { throw new DOMException("Blocked a frame with origin", "SecurityError"); }, configurable: true,
    });

    const report = run();

    expect(report.iframes).toBe(2);
    expect(report.sameOriginIframes).toBe(1);
    expect(report.elementScanIncomplete).toMatch(/2 iframe\(s\) \(1 same-origin\)/);
  });

  it("walks the sheets of at most listCap open shadow roots and says how many it did not", () => {
    const hosts = LAYOUT_REPORT_LIST_CAP + 1;
    document.body.innerHTML = Array.from({ length: hosts }, (_, i) => `<div id="h${i}" data-rect="0,${i * 20},390,20"></div>`).join("");
    for (let i = 0; i < hosts; i++) {
      const root = (document.getElementById(`h${i}`) as HTMLElement).attachShadow({ mode: "open" });
      Object.defineProperty(root, "adoptedStyleSheets", { value: [group([media(`(min-width: ${i}px)`)])], configurable: true });
    }

    const report = withSheets([], Array.from({ length: hosts }, (_, i) => `(min-width: ${i}px)`));

    expect(report.openShadowRoots).toBe(hosts);
    expect(report.shadowRootStyleSheets).toBe(LAYOUT_REPORT_LIST_CAP);
    expect(report.matchingMediaQueriesTotal).toBe(LAYOUT_REPORT_LIST_CAP);
    expect(report.cssWalkIncomplete).toMatch(new RegExp(`only ${LAYOUT_REPORT_LIST_CAP} of ${hosts} open shadow root\\(s\\) had their stylesheets walked`));
  });

  it("walks an open shadow root's adopted stylesheets", () => {
    document.body.innerHTML = `<div id="host" data-rect="0,0,390,20"></div>`;
    const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
    Object.defineProperty(root, "adoptedStyleSheets", { value: [group([media("(max-width: 400px)")])], configurable: true });
    const report = withSheets([], ["(max-width: 400px)"]);

    expect(report.matchingMediaQueries).toEqual(["(max-width: 400px)"]);
    expect(report.shadowRootStyleSheets).toBe(1);
  });

  it("scan cap fires only when a node was skipped: exactly SCAN nodes is clean, SCAN+1 is flagged", () => {
    const fill = (count: number) => Array.from({ length: count }, () => `<i data-rect="0,0,1,1"></i>`).join("");
    document.body.innerHTML = "";
    const chrome = document.querySelectorAll("*").length;

    document.body.innerHTML = fill(LAYOUT_REPORT_SCAN_CAP - chrome);
    expect(document.querySelectorAll("*").length).toBe(LAYOUT_REPORT_SCAN_CAP);
    const exact = run();
    expect(exact.scanTruncated).toBe(false);
    expect(exact.elementsScanned).toBe(LAYOUT_REPORT_SCAN_CAP);
    expect(exact.elementScanIncomplete).toBeNull();

    document.body.innerHTML = fill(LAYOUT_REPORT_SCAN_CAP - chrome + 1);
    const over = run();
    expect(over.scanTruncated).toBe(true);
    expect(over.elementsScanned).toBe(LAYOUT_REPORT_SCAN_CAP);
    expect(over.elementScanIncomplete).toMatch(/stopped after 4000 nodes/);
  });

  /**
   * Shadow-root sheet discovery happens inside the element loop over the
   * first SCAN nodes, so a host past the cap is never seen and its responsive
   * CSS is never walked. The old code flagged only the ELEMENT scan here and
   * printed a bare zero for @media.
   */
  it("a capped element scan flags the CSS walk too: a late shadow host's matching @media is unseen AND said so", () => {
    const filler = Array.from({ length: LAYOUT_REPORT_SCAN_CAP + 50 }, () => `<i data-rect="0,0,1,1"></i>`).join("");
    document.body.innerHTML = `${filler}<div id="late-host" data-rect="0,0,390,20"></div>`;
    const root = (document.getElementById("late-host") as HTMLElement).attachShadow({ mode: "open" });
    Object.defineProperty(root, "adoptedStyleSheets", { value: [group([media("(max-width: 400px)")])], configurable: true });

    const report = withSheets([], ["(max-width: 400px)"]);

    expect(report.scanTruncated).toBe(true);
    expect(report.openShadowRoots).toBe(0);
    expect(report.matchingMediaQueries).toEqual([]);
    expect(report.elementScanIncomplete).toMatch(/stopped after 4000 nodes/);
    expect(report.cssWalkIncomplete).not.toBeNull();
    expect(report.cssWalkIncomplete).toMatch(/element scan capped before all shadow roots\/iframes could be visited/);
    expect(report.cssWalkIncomplete).toMatch(/after node 4000 was never seen and its stylesheets were not walked/);
  });

  it("the same shadow host UNDER the cap is walked and the query found, with no flag", () => {
    document.body.innerHTML = `<i data-rect="0,0,1,1"></i><div id="host" data-rect="0,0,390,20"></div>`;
    const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
    Object.defineProperty(root, "adoptedStyleSheets", { value: [group([media("(max-width: 400px)")])], configurable: true });

    const report = withSheets([], ["(max-width: 400px)"]);

    expect(report.matchingMediaQueries).toEqual(["(max-width: 400px)"]);
    expect(report.cssWalkIncomplete).toBeNull();
  });
});

/**
 * The no-mutation harness.
 *
 * THE SNAPSHOT COVERS (observableState):
 *   - the serialized light DOM (outerHTML);
 *   - the innerHTML and adopted-sheet count of each OPEN shadow root reachable
 *     from the light DOM;
 *   - the live value of each input/textarea/select;
 *   - for document.styleSheets and document.adoptedStyleSheets: per-sheet
 *     `disabled`, rule count, and per-rule cssText / selectorText /
 *     media.mediaText (so replaceSync, insertRule/deleteRule, a rewritten
 *     condition or selector, and a disabled sheet show);
 *   - title, designMode, window.name, location, history length, focus, scroll;
 *   - localStorage length and keys, document.cookie;
 *   - the own properties of window by getOwnPropertyNames plus
 *     getOwnPropertySymbols, enumerable or not: primitives by VALUE, functions
 *     and objects by IDENTITY (a per-run identity table, so a replaced
 *     window.matchMedia / getComputedStyle / setTimeout is a different id);
 *   - by identity, the prototype methods the script calls that do not live on
 *     window: Element.prototype.getBoundingClientRect / querySelectorAll /
 *     getAttribute, Document.prototype.querySelectorAll, Array.prototype.slice /
 *     filter / indexOf.
 *
 * THE INTERCEPT LIST (proveReadOnly) supplements it for effects with nothing
 * to diff: scheduling (setTimeout / setInterval / setImmediate / queueMicrotask
 * / requestAnimationFrame / postMessage — caught when SCHEDULED; the harness
 * also flushes the microtask queue and one macrotask before the after-snapshot),
 * customElements.define, attachShadow, history and scroll calls, sheet and
 * style-declaration writes, observer registration. A method the script
 * REPLACES rather than calls is reported too: restore() checks the wrapper is
 * still in place.
 *
 * NOT COVERED:
 *   - a deferral through a channel neither intercepted nor flushed: a listener
 *     the page fires later, a pre-existing MutationObserver /
 *     IntersectionObserver callback, an Image/fetch load handler;
 *   - mutations happy-dom does not model and that leave nothing to diff:
 *     el.animate(), CSS.registerProperty() — intercepted by name where the
 *     host defines the API, a denylist;
 *   - a CLOSED shadow root the page created before the script ran;
 *   - ShadowRoot.styleSheets: happy-dom's ShadowRoot has none, so the script's
 *     addSheets(root.styleSheets) branch runs on an absent list here and its
 *     behaviour on a populated one is not exercised by this file;
 *   - the prototype chain beyond the methods named above, and any getter with
 *     side effects;
 *   - a window accessor that returns a fresh object on each read (happy-dom's
 *     window.CSS): it has no identity to pin, so a replacement is not seen;
 *   - anything observable only in a real browser: layout/paint side effects,
 *     scroll anchoring, cross-frame effects.
 */
function observableState(ids: Map<unknown, number>): string {
  const identity = (v: unknown): string => {
    if (!ids.has(v)) ids.set(v, ids.size);
    return `#${ids.get(v)}`;
  };
  const describeValue = (v: unknown): string => {
    const t = typeof v;
    return t === "string" || t === "number" || t === "boolean" || t === "undefined" || v === null ? `=${String(v)}` : `:${t}${identity(v)}`;
  };
  const win = window as unknown as Record<PropertyKey, unknown>;
  const describeProp = (k: PropertyKey): string => {
    let v: unknown;
    let again: unknown;
    try { v = win[k]; again = win[k]; } catch { return `${String(k)}:throws`; }
    // An accessor that mints a new object per read (happy-dom's window.CSS)
    // has no identity to pin; it is recorded as such and listed as not covered.
    if (v !== again && (typeof v === "object" || typeof v === "function")) return `${String(k)}:${typeof v}:fresh`;
    return `${String(k)}${describeValue(v)}`;
  };
  const globals = [
    ...Object.getOwnPropertyNames(win).sort().map(describeProp),
    ...Object.getOwnPropertySymbols(win).map((s) => describeProp(s)).sort(),
  ];
  const prototypes = [
    ["Element.getBoundingClientRect", Element.prototype.getBoundingClientRect],
    ["Element.querySelectorAll", Element.prototype.querySelectorAll],
    ["Element.getAttribute", Element.prototype.getAttribute],
    ["Document.querySelectorAll", Document.prototype.querySelectorAll],
    ["Array.slice", Array.prototype.slice],
    ["Array.filter", Array.prototype.filter],
    ["Array.indexOf", Array.prototype.indexOf],
  ].map(([name, fn]) => `${String(name)}${describeValue(fn)}`);
  const fields = [...document.querySelectorAll("input, textarea, select")]
    .map((el) => `${el.id}=${(el as HTMLInputElement).value}`);
  const describeSheet = (sheet: CSSStyleSheet): string => {
    let rules: string;
    try {
      rules = [...sheet.cssRules].map((r) => {
        const styleRule = r as Partial<CSSStyleRule>;
        const mediaRule = r as Partial<CSSMediaRule>;
        return `${r.cssText}|sel=${styleRule.selectorText ?? ""}|media=${mediaRule.media?.mediaText ?? ""}`;
      }).join("\n");
    } catch { rules = "unreadable"; }
    return `disabled=${sheet.disabled};${rules}`;
  };
  const sheets = [...document.styleSheets].map(describeSheet);
  const adoptedSheets = [...document.adoptedStyleSheets].map(describeSheet);
  const shadowRoots = [...document.querySelectorAll("*")].flatMap((el) => {
    const root = el.shadowRoot;
    return root ? [`${el.tagName}#${el.id}:${root.innerHTML}|adopted=${root.adoptedStyleSheets.length}`] : [];
  });
  const active = document.activeElement as HTMLElement | null;
  const storage = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  return JSON.stringify({
    html: document.documentElement.outerHTML,
    shadowRoots,
    fields,
    sheets,
    adoptedSheets,
    title: document.title,
    designMode: document.designMode,
    windowName: window.name,
    href: String(document.location.href),
    historyLength: history.length,
    active: active ? `${active.tagName}#${active.id}` : null,
    scroll: [window.scrollX, window.scrollY, document.documentElement.scrollTop, document.documentElement.scrollLeft],
    storage,
    cookie: document.cookie,
    globals,
    prototypes,
  });
}

/** Runs `script` under the harness. Returns whether the snapshot changed and
 *  which intercepted APIs were called or replaced; the caller asserts. */
async function proveReadOnly(script: string): Promise<{ changed: boolean; called: string[] }> {
  // Materialize each sheet BEFORE the snapshot and the intercepts go in:
  // happy-dom builds a <style> element's CSSStyleSheet on the first
  // styleSheets read, via one replaceSync call of its own. Read now so that
  // call is the harness's, not attributed to the script.
  void document.styleSheets.length;
  for (const el of document.querySelectorAll("*")) void el.shadowRoot?.styleSheets?.length;
  // The before-snapshot is taken BEFORE the intercepts install so the identity
  // of an intercepted method compares to itself once restore() has run.
  const ids = new Map<unknown, number>();
  const before = observableState(ids);
  const called: string[] = [];
  const restore: (() => void)[] = [];
  const intercept = (host: object | undefined, name: string) => {
    if (!host) return;
    const target = host as Record<string, unknown>;
    if (typeof target[name] !== "function") return;
    const original = target[name];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      called.push(name);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    target[name] = wrapper;
    restore.push(() => {
      if (target[name] !== wrapper) called.push(`replaced:${name}`);
      target[name] = original;
    });
  };
  for (const name of ["scrollIntoView", "focus", "blur", "click", "setAttribute", "removeAttribute", "remove", "insertBefore", "appendChild", "requestFullscreen", "animate", "attachShadow"]) {
    intercept(Element.prototype, name);
  }
  for (const name of ["replaceState", "pushState", "back", "forward", "go"]) intercept(history, name);
  for (const name of ["scrollTo", "scrollBy", "scroll", "open", "close", "alert", "postMessage", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame"]) {
    intercept(window, name);
  }
  for (const name of ["write", "open", "close"]) intercept(Document.prototype, name);
  for (const name of ["insertRule", "deleteRule", "replaceSync", "replace"]) intercept(CSSStyleSheet.prototype, name);
  intercept(CSSStyleDeclaration.prototype, "setProperty");
  intercept(CSSStyleDeclaration.prototype, "removeProperty");
  intercept(Object.getPrototypeOf(customElements), "define");
  intercept((globalThis as { CSS?: object }).CSS, "registerProperty");
  intercept((globalThis as { IntersectionObserver?: { prototype: object } }).IntersectionObserver?.prototype, "observe");
  intercept((globalThis as { MutationObserver?: { prototype: object } }).MutationObserver?.prototype, "observe");

  try {
    runScript(script);
  } finally {
    for (const undo of restore) undo();
  }
  // Flush what a deferral could have queued: the microtask queue, then one
  // real macrotask (setTimeout 0 / setImmediate land here).
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { changed: observableState(ids) !== before, called };
}

function mutationPage(): void {
  document.body.innerHTML =
    `<style>@media (max-width: 767px) { .x { color: red } } .y { color: blue }</style>` +
    `<div id="promo-strip" data-rect="0,0,427,32">Free shipping</div>` +
    `<nav class="site-nav" data-rect="0,32,390,56" style="position: fixed">Home</nav>` +
    `<div id="host" data-rect="0,90,390,20"></div>` +
    `<input id="typed" value="untouched">` +
    `<button id="focused">Focus me</button>`;
  (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" }).innerHTML = "<span>inside</span>";
  document.title = "Original title";
  window.name = "original-window-name";
  (document.getElementById("focused") as HTMLElement).focus();
}

describe("layout_report script does not mutate the page", () => {
  const ORIGINAL_MATCH_MEDIA = window.matchMedia;
  const ORIGINAL_GET_COMPUTED_STYLE = window.getComputedStyle;

  it("leaves the observable state byte-identical and calls no intercepted API", async () => {
    mutationPage();

    const outcome = await proveReadOnly(LAYOUT_REPORT_SCRIPT);

    expect(outcome.called).toEqual([]);
    expect(outcome.changed).toBe(false);
  });

  /** Guards the guard: each listed escape runs the REAL script with the
   *  mutation prepended and must go red. A harness that went blind passes
   *  the test above and fails these. */
  const escape = (mutation: string) => `(() => { ${mutation}; return ${LAYOUT_REPORT_SCRIPT}; })()`;
  const ESCAPES: [string, string, () => void][] = [
    ["window.name assignment (the original denylist escape)", `window.name = "pwned"`, () => { window.name = ""; }],
    ["non-enumerable window property", `Object.defineProperty(window, "__lr_hidden", { value: 1, enumerable: false, configurable: true })`,
      () => { delete (window as unknown as Record<string, unknown>).__lr_hidden; }],
    ["symbol-keyed window property", `window[Symbol.for("lr-escape")] = 1`,
      () => { delete (window as unknown as Record<symbol, unknown>)[Symbol.for("lr-escape")]; }],
    ["setTimeout(fn, 0) deferral", `setTimeout(() => { document.title = "late"; }, 0)`, () => { document.title = ""; }],
    ["queueMicrotask deferral", `queueMicrotask(() => { window.name = "late"; })`, () => { window.name = ""; }],
    ["promise-chained deferral (no interceptable call at all)", `Promise.resolve().then(() => { document.title = "late"; })`, () => { document.title = ""; }],
    ["customElements.define", `customElements.define("x-lr-escape-" + Math.random().toString(36).slice(2), class extends HTMLElement {})`, () => {}],
    ["document.adoptedStyleSheets replaced", `document.adoptedStyleSheets = [new CSSStyleSheet()]`, () => { document.adoptedStyleSheets = []; }],
    ["DOM mutation inside an open shadow root", `document.getElementById("host").shadowRoot.innerHTML = "<b>changed</b>"`, () => {}],
    ["replaceSync on a <style>-backed sheet", `document.styleSheets[0].replaceSync(".z{color:green} .w{color:red}")`, () => {}],
    ["insertRule", `document.styleSheets[0].insertRule(".z { color: green }", 0)`, () => {}],
    ["form field value", `document.getElementById("typed").value = "typed-into"`, () => {}],
    ["designMode", `document.designMode = "on"`, () => { document.designMode = "off"; }],
    ["attachShadow (a closed root would be invisible afterwards)", `document.getElementById("promo-strip").attachShadow({ mode: "closed" })`, () => {}],
    // F2: the previous harness recorded only `typeof` for non-primitives and
    // nothing at all for the state below, so each of these stayed green.
    ["window.matchMedia replaced", `window.matchMedia = () => ({ matches: false, media: "" })`, () => { window.matchMedia = ORIGINAL_MATCH_MEDIA; }],
    ["window.getComputedStyle replaced", `window.getComputedStyle = window.getComputedStyle.bind(window)`, () => { window.getComputedStyle = ORIGINAL_GET_COMPUTED_STYLE; }],
    ["Element.prototype.getBoundingClientRect replaced", `Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; }`, () => {}],
    ["an intercepted prototype method replaced, not called", `Element.prototype.setAttribute = function () {}`, () => {}],
    ["sheet.disabled", `document.styleSheets[0].disabled = true`, () => {}],
    ["rule.media.mediaText rewritten", `document.styleSheets[0].cssRules[0].media.mediaText = "print"`, () => {}],
    ["rule.selectorText shadowed", `Object.defineProperty(document.styleSheets[0].cssRules[1], "selectorText", { value: ".hacked", configurable: true })`, () => {}],
    ["localStorage.setItem", `localStorage.setItem("lr-escape", "1")`, () => { localStorage.clear(); }],
    ["document.cookie", `document.cookie = "lr_escape=1"`, () => { document.cookie = "lr_escape=; expires=Thu, 01 Jan 1970 00:00:00 GMT"; }],
  ];

  it.each(ESCAPES)("goes red for: %s", async (_label, mutation, cleanup) => {
    mutationPage();
    try {
      const outcome = await proveReadOnly(escape(mutation));
      expect(outcome.changed || outcome.called.length > 0).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("layout_report script and the evaluate guards", () => {
  it("clears the evaluate guards the handler exempts it from, so no guard had to be weakened for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
    expect(evaluateMutationReason(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });
});

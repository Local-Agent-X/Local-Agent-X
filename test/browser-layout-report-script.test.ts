// @vitest-environment happy-dom
/**
 * The layout diagnostic script, run against a REAL DOM.
 *
 * Two things are proven here that a mocked backend cannot show:
 *   1. it actually measures — an element wider than the viewport is found and
 *      named, and a page that fits reports clean;
 *   2. it MUTATES NOTHING. The serialized document is compared byte-for-byte
 *      before and after. That is the whole safety case for running it outside
 *      the `evaluate` inspection-only heuristic, so it is asserted, not argued.
 *
 * happy-dom does no layout, so rects come from a per-element `data-rect`
 * attribute (same approach as browser-extract-stable-ids.test.ts).
 * Lives under test/ because the root tsconfig compiles src/ without the DOM lib.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LAYOUT_REPORT_SCRIPT } from "../src/browser/layout-report.js";
import { scanEvaluateScript } from "../src/browser/guards.js";
import { evaluateMutationReason } from "../src/tools/browser-tools/page.js";

const VIEWPORT = 390;

interface LayoutReport {
  matchingMediaQueries: string[];
  matchingMediaQueriesTotal: number;
  unreadableStyleSheets: number;
  cssRulesTruncated: boolean;
  documentScroll: { scrollWidth: number; clientWidth: number; horizontalOverflowPx: number };
  overflowingElements: { selector: string; overflowRightPx: number; backgroundColor: string }[];
  overflowingElementsTotal: number;
  fixedAndStickyElements: { selector: string; position: string }[];
  fixedAndStickyTotal: number;
  backgrounds: { html: string; body: string; canvas: string };
  viewport: { clientWidth: number };
  elementsScanned: number;
  listCap: number;
}

function box(el: Element): DOMRect {
  const raw = (el as HTMLElement).dataset?.rect;
  const [x, y, width, height] = raw ? raw.split(",").map(Number) : [0, 0, 100, 20];
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect;
}

function run(): LayoutReport {
  return new Function(`return ${LAYOUT_REPORT_SCRIPT}`)() as LayoutReport;
}

beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  Element.prototype.getBoundingClientRect = function () { return box(this); };
  for (const [prop, value] of [["clientWidth", VIEWPORT], ["clientHeight", 844]] as const) {
    Object.defineProperty(document.documentElement, prop, { value, configurable: true });
  }
});

describe("layout_report script", () => {
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

  it("reports clean for a page that fits", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">Fits exactly</p>`;
    Object.defineProperty(document.documentElement, "scrollWidth", { value: VIEWPORT, configurable: true });

    const report = run();

    expect(report.documentScroll.horizontalOverflowPx).toBe(0);
    expect(report.overflowingElements).toEqual([]);
    expect(report.overflowingElementsTotal).toBe(0);
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

  /**
   * FINDING 7: the old version of this compared outerHTML plus one input value
   * and finished with `expect(location.href).toBe(location.href)` — a
   * tautology. Adding `el.scrollIntoView()` or `history.replaceState(...)` to
   * the script would have passed it (and passed evaluateMutationReason), while
   * scrolling the user's page out from under them and rewriting the URL. The
   * proof now covers the mutations that leave the serialized DOM untouched:
   * scroll position, focus, and history — asserted both by OUTCOME (the values
   * afterwards) and by INTERCEPT (the APIs were never called at all).
   */
  it("does not mutate the page — DOM, scroll, focus, history or location", () => {
    document.body.innerHTML =
      `<div id="promo-strip" data-rect="0,0,427,32">Free shipping</div>` +
      `<nav class="site-nav" data-rect="0,32,390,56" style="position: fixed">Home</nav>` +
      `<input id="typed" value="untouched">` +
      `<button id="focused">Focus me</button>`;
    const focused = document.getElementById("focused") as HTMLElement;
    focused.focus();

    // INTERCEPT: every API that mutates without changing outerHTML. Each is
    // replaced by a recorder, so a call is caught even when its effect is
    // invisible to (or unsupported by) the DOM implementation.
    const called: string[] = [];
    const restore: (() => void)[] = [];
    const intercept = (host: object, name: string) => {
      const target = host as Record<string, unknown>;
      if (typeof target[name] !== "function") return;
      const original = target[name];
      target[name] = function (...args: unknown[]) {
        called.push(name);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restore.push(() => { target[name] = original; });
    };
    for (const name of ["scrollIntoView", "focus", "blur", "click", "setAttribute", "removeAttribute", "remove", "insertBefore", "appendChild", "requestFullscreen"]) {
      intercept(Element.prototype, name);
    }
    for (const name of ["replaceState", "pushState", "back", "forward", "go"]) intercept(history, name);
    for (const name of ["scrollTo", "scrollBy", "scroll", "open", "close", "alert"]) intercept(window, name);
    for (const name of ["write", "open", "close"]) intercept(Document.prototype, name);

    const htmlBefore = document.documentElement.outerHTML;
    const inputBefore = (document.getElementById("typed") as HTMLInputElement).value;
    const activeBefore = document.activeElement;
    const scrollBefore = [window.scrollX, window.scrollY, document.documentElement.scrollTop, document.documentElement.scrollLeft];
    const hrefBefore = String(document.location.href);
    const historyLengthBefore = history.length;

    try {
      run();
    } finally {
      for (const undo of restore) undo();
    }

    expect(called).toEqual([]);
    expect(document.documentElement.outerHTML).toBe(htmlBefore);
    expect((document.getElementById("typed") as HTMLInputElement).value).toBe(inputBefore);
    expect(document.activeElement).toBe(activeBefore);
    expect([window.scrollX, window.scrollY, document.documentElement.scrollTop, document.documentElement.scrollLeft])
      .toEqual(scrollBefore);
    expect(String(document.location.href)).toBe(hrefBefore);
    expect(history.length).toBe(historyLengthBefore);
  });

  /**
   * FINDING 6: the walk iterated sheet.cssRules ONE level deep, so an @media
   * nested inside @layer / @supports / another @media — the normal shape of a
   * modern or Tailwind build — was never visited, and the report said the page
   * had no matching media queries at all.
   *
   * The rules are stubbed rather than parsed: happy-dom's CSSOM does not build
   * nested grouping rules, and what is under test is the WALK, not a parser.
   */
  describe("@media discovery", () => {
    const media = (mediaText: string, children: unknown[] = []) => ({ media: { mediaText }, cssRules: children });
    /** @layer / @supports: a grouping rule with children and NO .media. */
    const group = (children: unknown[]) => ({ cssRules: children });

    function withSheets(sheets: unknown[], matches: string[]): LayoutReport {
      Object.defineProperty(document, "styleSheets", { value: sheets, configurable: true });
      const previous = globalThis.matchMedia;
      globalThis.matchMedia = ((q: string) => ({ matches: matches.includes(q), media: q })) as typeof matchMedia;
      try { return run(); } finally { globalThis.matchMedia = previous; }
    }

    it("finds an @media nested inside @layer > @supports", () => {
      const report = withSheets(
        [group([group([group([media("(max-width: 767px)")])])])],
        ["(max-width: 767px)"],
      );

      expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
      expect(report.matchingMediaQueriesTotal).toBe(1);
    });

    it("finds an @media nested inside another @media, and reports only the matching ones", () => {
      const report = withSheets(
        [group([media("(min-width: 320px)", [media("(orientation: portrait)")])]), group([media("print")])],
        ["(min-width: 320px)", "(orientation: portrait)"],
      );

      expect(report.matchingMediaQueries.sort()).toEqual(["(min-width: 320px)", "(orientation: portrait)"]);
      expect(report.matchingMediaQueries).not.toContain("print");
    });

    it("counts a cross-origin sheet it cannot read instead of silently reporting zero", () => {
      const cdn = { get cssRules(): unknown { throw new Error("SecurityError: cross-origin stylesheet"); } };
      const report = withSheets([cdn, group([media("(max-width: 767px)")])], ["(max-width: 767px)"]);

      expect(report.unreadableStyleSheets).toBe(1);
      expect(report.matchingMediaQueries).toEqual(["(max-width: 767px)"]);
    });

    it("bounds the walk: neither depth nor rule count can run away", () => {
      // Deeper than RULE_DEPTH — the innermost query must NOT be reported, and
      // the walk must return rather than recurse forever.
      let deep: unknown = media("(max-width: 1px)");
      for (let i = 0; i < 40; i++) deep = group([deep]);
      const deepReport = withSheets([deep as { cssRules: unknown[] }], ["(max-width: 1px)"]);
      expect(deepReport.matchingMediaQueries).toEqual([]);

      // Wider than RULE_CAP — the budget trips and says so.
      const wide = group(Array.from({ length: 25000 }, () => group([])));
      const wideReport = withSheets([wide], []);
      expect(wideReport.cssRulesTruncated).toBe(true);
    });
  });

  it("clears the evaluate guards it is exempted from, so no guard had to be weakened for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
    expect(evaluateMutationReason(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });
});

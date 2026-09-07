// @vitest-environment happy-dom
/**
 * The layout diagnostic script, run against a REAL DOM.
 *
 * Two things are proven here that a mocked backend cannot show:
 *   1. it actually measures — an element wider than the viewport is found and
 *      named, and a page that fits reports clean;
 *   2. it mutates nothing OBSERVABLE HERE. A structural snapshot of the page's
 *      observable state (DOM, field values, sheet rule counts, window.name,
 *      title, designMode, focus, scroll, history, location, and every own
 *      enumerable window property) is diffed before/after, so an unforeseen
 *      mutation fails by outcome instead of having to be on a list. The exact
 *      classes this still cannot see are enumerated on that test - it is the
 *      strongest available proof under happy-dom, not a total one.
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
   * FINDING 3: the previous version of this proof was a DENYLIST — it recorded
   * calls to a fixed list of method names, so it could not see a property
   * ASSIGNMENT at all. Verified: adding `window.name = "pwned-by-layout-report"`
   * to the script left all nine tests green, and both scanEvaluateScript and
   * evaluateMutationReason returned null for it. window.name survives navigation
   * and is readable cross-origin.
   *
   * The proof is now STRUCTURAL: observable state is snapshotted before the run
   * and diffed after, so a mutation nobody anticipated fails by OUTCOME rather
   * than by having been listed. The snapshot covers the serialized DOM, every
   * form field's live value, per-sheet rule counts (insertRule / deleteRule /
   * rule.style.setProperty — objects the walk itself holds), window.name,
   * document.title, document.designMode, location, history length, focus,
   * scroll, and every own enumerable property of `window` (which catches an
   * arbitrary `window.anything = ...`).
   *
   * WHAT THIS STILL CANNOT SEE, honestly:
   *   - Mutations whose only effect is unimplemented in happy-dom, so they
   *     change no observable state here: el.animate(), CSS.registerProperty(),
   *     IntersectionObserver/MutationObserver.observe(). These leave nothing to
   *     diff, so the name-based INTERCEPT below is retained specifically for
   *     them — a denylist as a supplement, never as the whole case.
   *   - CSSStyleSheet.replaceSync on a <style>-backed sheet: happy-dom re-parses
   *     the <style> text on every styleSheets read, so the change is erased
   *     before it can be diffed AND the harness's own re-parse makes the method
   *     name unusable as a signal. insertRule/deleteRule ARE covered.
   *   - Anything observable only in a real browser (layout/paint side effects,
   *     scroll anchoring, cross-frame effects). The real defense for those is
   *     that the script is a fixed constant reviewed as read-only, not this test.
   */
  function observableState(): string {
    const win = window as unknown as Record<string, unknown>;
    const globals = Object.keys(win).sort().map((k) => {
      const v = win[k];
      const t = typeof v;
      return t === "string" || t === "number" || t === "boolean" ? `${k}=${String(v)}` : `${k}:${t}`;
    });
    const fields = [...document.querySelectorAll("input, textarea, select")]
      .map((el) => `${el.id}=${(el as HTMLInputElement).value}`);
    const sheetRuleCounts = [...document.styleSheets].map((sheet) => {
      try { return sheet.cssRules.length; } catch { return "unreadable"; }
    });
    const active = document.activeElement as HTMLElement | null;
    return JSON.stringify({
      html: document.documentElement.outerHTML,
      fields,
      sheetRuleCounts,
      title: document.title,
      designMode: document.designMode,
      windowName: window.name,
      href: String(document.location.href),
      historyLength: history.length,
      active: active ? `${active.tagName}#${active.id}` : null,
      scroll: [window.scrollX, window.scrollY, document.documentElement.scrollTop, document.documentElement.scrollLeft],
      globals,
    });
  }

  it("does not mutate the page — proven by diffing observable state, not by a list of banned method names", () => {
    document.body.innerHTML =
      `<style>@media (max-width: 767px) { .x { color: red } } .y { color: blue }</style>` +
      `<div id="promo-strip" data-rect="0,0,427,32">Free shipping</div>` +
      `<nav class="site-nav" data-rect="0,32,390,56" style="position: fixed">Home</nav>` +
      `<input id="typed" value="untouched">` +
      `<button id="focused">Focus me</button>`;
    document.title = "Original title";
    window.name = "original-window-name";
    (document.getElementById("focused") as HTMLElement).focus();

    // SUPPLEMENT, not the case: APIs whose effect happy-dom does not model, so
    // the structural diff has nothing to compare.
    const called: string[] = [];
    const restore: (() => void)[] = [];
    const intercept = (host: object | undefined, name: string) => {
      if (!host) return;
      const target = host as Record<string, unknown>;
      if (typeof target[name] !== "function") return;
      const original = target[name];
      target[name] = function (...args: unknown[]) {
        called.push(name);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restore.push(() => { target[name] = original; });
    };
    for (const name of ["scrollIntoView", "focus", "blur", "click", "setAttribute", "removeAttribute", "remove", "insertBefore", "appendChild", "requestFullscreen", "animate", "attachShadow"]) {
      intercept(Element.prototype, name);
    }
    for (const name of ["replaceState", "pushState", "back", "forward", "go"]) intercept(history, name);
    for (const name of ["scrollTo", "scrollBy", "scroll", "open", "close", "alert"]) intercept(window, name);
    for (const name of ["write", "open", "close"]) intercept(Document.prototype, name);
    // NOT replaceSync: happy-dom's document.styleSheets getter RE-PARSES each
    // <style> through replaceSync on every access, so it fires from the harness
    // itself (verified) and would flag every read. It is also the one sheet
    // mutation the structural diff cannot see here, for the same reason - the
    // next styleSheets read re-parses the <style> text over it. In a real
    // browser it would show up as changed rule counts.
    for (const name of ["insertRule", "deleteRule"]) intercept(CSSStyleSheet.prototype, name);
    intercept(CSSStyleDeclaration.prototype, "setProperty");
    intercept(CSSStyleDeclaration.prototype, "removeProperty");
    intercept((globalThis as { CSS?: object }).CSS, "registerProperty");
    intercept((globalThis as { IntersectionObserver?: { prototype: object } }).IntersectionObserver?.prototype, "observe");
    intercept((globalThis as { MutationObserver?: { prototype: object } }).MutationObserver?.prototype, "observe");

    const before = observableState();
    try {
      run();
    } finally {
      for (const undo of restore) undo();
    }

    expect(observableState()).toBe(before);
    expect(called).toEqual([]);
  });

  it("the state snapshot actually detects a mutation — including a bare property assignment", () => {
    // Guards the guard: if observableState() went blind (or was reduced to a
    // tautology, as an earlier version of this file was), these would pass with
    // the mutations applied. window.name is the exact assignment that walked
    // through the old denylist.
    document.body.innerHTML = `<input id="typed" value="untouched"><style>.y { color: blue }</style>`;
    const baseline = observableState();

    window.name = "pwned-by-layout-report";
    expect(observableState()).not.toBe(baseline);
    window.name = "";

    document.title = "retitled";
    expect(observableState()).not.toBe(baseline);
    document.title = "";

    document.designMode = "on";
    expect(observableState()).not.toBe(baseline);
    document.designMode = "off";

    (document.getElementById("typed") as HTMLInputElement).value = "typed-into";
    expect(observableState()).not.toBe(baseline);
    (document.getElementById("typed") as HTMLInputElement).value = "untouched";

    (window as unknown as Record<string, unknown>).__unforeseen = 1;
    expect(observableState()).not.toBe(baseline);
    delete (window as unknown as Record<string, unknown>).__unforeseen;

    document.styleSheets[0]?.insertRule(".z { color: green }", 0);
    expect(observableState()).not.toBe(baseline);
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

    /**
     * FINDING 1 (critical): the depth cap returned SILENTLY, and this test
     * pinned the silence — it asserted the innermost query was dropped and
     * asserted nothing about a flag. The only signal the script emitted was the
     * rule-COUNT cap, so a page nesting @layer > @supports > @media past the cap
     * reported "0 matching @media quer(ies)" with every flag clean: verbatim the
     * wrong conclusion this action exists to prevent. Dropping the rules is
     * correct; dropping them quietly is the bug.
     */
    it("bounds the walk by DEPTH and SAYS SO instead of reporting a clean zero", () => {
      let deep: unknown = media("(max-width: 1px)");
      for (let i = 0; i < 40; i++) deep = group([deep]);
      const deepReport = withSheets([deep as { cssRules: unknown[] }], ["(max-width: 1px)"]);

      expect(deepReport.matchingMediaQueries).toEqual([]);
      expect(deepReport.cssDepthTruncated).toBe(true);
      expect(deepReport.cssWalkIncomplete).toMatch(/nesting-depth cap/);
      expect(deepReport.cssWalkIncomplete).toMatch(/every rule below those points was skipped/);
    });

    it("bounds the walk by rule COUNT and says so", () => {
      const wide = group(Array.from({ length: 25000 }, () => group([])));
      const wideReport = withSheets([wide], []);

      expect(wideReport.cssRulesTruncated).toBe(true);
      expect(wideReport.cssWalkIncomplete).toMatch(/hit its cap of \d+ rules/);
    });

    it("reports a complete walk as complete — the flags are not always-on", () => {
      const report = withSheets([group([media("(max-width: 767px)")])], ["(max-width: 767px)"]);

      expect(report.cssDepthTruncated).toBe(false);
      expect(report.cssRulesTruncated).toBe(false);
      expect(report.cssWalkIncomplete).toBeNull();
    });

    /**
     * FINDING 2: document.styleSheets is not every sheet. A constructed sheet
     * handed to document.adoptedStyleSheets is not a member of it, so a page
     * whose responsive CSS is entirely adopted reported zero matching queries
     * with every flag benign.
     */
    it("walks document.adoptedStyleSheets, not only document.styleSheets", () => {
      const adopted = [group([media("(max-width: 500px)")])];
      Object.defineProperty(document, "adoptedStyleSheets", { value: adopted, configurable: true });
      try {
        const report = withSheets([], ["(max-width: 500px)"]);
        expect(report.matchingMediaQueries).toEqual(["(max-width: 500px)"]);
        expect(report.adoptedStyleSheets).toBe(1);
        expect(report.cssWalkIncomplete).toBeNull();
      } finally {
        Object.defineProperty(document, "adoptedStyleSheets", { value: [], configurable: true });
      }
    });
  });

  /**
   * FINDING 2: querySelectorAll("*") pierces neither shadow roots nor iframe
   * documents, so an overflowing element inside a web component is never
   * measured — and the report used to print a bare "0 element(s) extend past
   * the viewport" over it. The elements inside are still not measured; what
   * changed is that the report no longer presents that count as complete.
   */
  describe("unmeasurable subtrees are counted, not ignored", () => {
    it("counts open shadow roots and iframes and marks the element counts as floors", () => {
      document.body.innerHTML =
        `<div id="host" data-rect="0,0,390,20"></div><iframe id="frame" data-rect="0,20,390,100"></iframe>`;
      const host = document.getElementById("host") as HTMLElement;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<div data-rect="0,0,900,20">wide inside the component</div>`;

      const report = run();

      expect(report.openShadowRoots).toBe(1);
      expect(report.iframes).toBe(1);
      // The wide element inside the shadow root is NOT in the count — that is
      // the honest limit, and the caveat is what makes it safe to read.
      expect(report.overflowingElementsTotal).toBe(0);
      expect(report.elementScanIncomplete).toMatch(/does not pierce shadow DOM/);
      expect(report.elementScanIncomplete).toMatch(/closed shadow roots cannot be detected at all/);
      expect(report.elementScanIncomplete).toMatch(/1 iframe\(s\)/);
      expect(report.cssWalkIncomplete).toMatch(/iframe\(s\) are on the page/);
    });

    it("walks an open shadow root's adopted stylesheets", () => {
      document.body.innerHTML = `<div id="host" data-rect="0,0,390,20"></div>`;
      const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
      Object.defineProperty(root, "adoptedStyleSheets", {
        value: [{ cssRules: [{ media: { mediaText: "(max-width: 400px)" }, cssRules: [] }] }],
        configurable: true,
      });
      const previous = globalThis.matchMedia;
      globalThis.matchMedia = ((q: string) => ({ matches: q === "(max-width: 400px)", media: q })) as typeof matchMedia;
      try {
        const report = run();
        expect(report.matchingMediaQueries).toEqual(["(max-width: 400px)"]);
        expect(report.shadowRootStyleSheets).toBeGreaterThan(0);
      } finally {
        globalThis.matchMedia = previous;
      }
    });

    it("says nothing about shadow roots or iframes on a page that has neither", () => {
      document.body.innerHTML = `<p data-rect="0,0,390,20">plain</p>`;

      const report = run();

      expect(report.openShadowRoots).toBe(0);
      expect(report.iframes).toBe(0);
      expect(report.elementScanIncomplete).toBeNull();
    });
  });

  it("clears the evaluate guards it is exempted from, so no guard had to be weakened for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
    expect(evaluateMutationReason(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });
});

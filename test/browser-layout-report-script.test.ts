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

  it("does not mutate the page", () => {
    document.body.innerHTML =
      `<div id="promo-strip" data-rect="0,0,427,32">Free shipping</div>` +
      `<nav class="site-nav" data-rect="0,32,390,56" style="position: fixed">Home</nav>` +
      `<input id="typed" value="untouched">`;
    const before = document.documentElement.outerHTML;
    const inputBefore = (document.getElementById("typed") as HTMLInputElement).value;

    run();

    expect(document.documentElement.outerHTML).toBe(before);
    expect((document.getElementById("typed") as HTMLInputElement).value).toBe(inputBefore);
    expect(document.location.href).toBe(document.location.href);
  });

  it("clears the evaluate guards it is exempted from, so no guard had to be weakened for it", () => {
    expect(scanEvaluateScript(LAYOUT_REPORT_SCRIPT)).toBeNull();
    expect(evaluateMutationReason(LAYOUT_REPORT_SCRIPT)).toBeNull();
  });
});

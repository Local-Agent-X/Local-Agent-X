// @vitest-environment happy-dom
/**
 * The layout diagnostic script, run against a REAL DOM.
 *
 * Proven here, which a mocked backend cannot show:
 *   1. it measures — an element wider than the viewport is found and named;
 *   2. every early return / catch in its walks is accounted for: each one
 *      either increments a counter that feeds a completeness flag, or is
 *      lossless for every count (the "silent skip" tests below);
 *   3. a capped ELEMENT scan also flags the CSS walk, because shadow-root and
 *      iframe sheet discovery lives inside the element loop;
 *   4. the known gaps are stated on every report, clean ones included;
 *   5. it does not mutate the page, to the extent a snapshot diff can show.
 *
 * ON (5), precisely: a mutation to any state the snapshot COVERS fails by
 * outcome, whether or not anyone anticipated it. The snapshot's coverage is
 * enumerated in observableState(); what it cannot cover is listed under
 * "WHAT THIS STILL CANNOT SEE". Each listed escape from the previous review
 * is either closed and verified by mutation below, or named there with the
 * reason it stays open. This is not a proof that the script is read-only in
 * a real browser — the real defense for that is that the script is a fixed
 * constant reviewed as read-only — it is the strongest available proof under
 * happy-dom, with its edges drawn.
 *
 * happy-dom does no layout, so rects come from a per-element `data-rect`
 * attribute (same approach as browser-extract-stable-ids.test.ts).
 * Lives under test/ because the root tsconfig compiles src/ without the DOM lib.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LAYOUT_REPORT_KNOWN_GAPS, LAYOUT_REPORT_SCAN_CAP, LAYOUT_REPORT_SCRIPT } from "../src/browser/layout-report.js";
import { scanEvaluateScript } from "../src/browser/guards.js";
import { evaluateMutationReason } from "../src/tools/browser-tools/page.js";

const VIEWPORT = 390;

interface LayoutReport {
  matchingMediaQueries: string[];
  matchingMediaQueriesTotal: number;
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
  fixedAndStickyElements: { selector: string; position: string }[];
  fixedAndStickyTotal: number;
  backgrounds: { html: string; body: string; canvas: string };
  viewport: { clientWidth: number };
  elementsScanned: number;
  scanTruncated: boolean;
  hiddenElementsSkipped: number;
  listCap: number;
  knownGaps: string[];
}

function box(el: Element): DOMRect {
  const raw = (el as HTMLElement).dataset?.rect;
  const [x, y, width, height] = raw ? raw.split(",").map(Number) : [0, 0, 100, 20];
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect;
}

function runScript(script: string): LayoutReport {
  return new Function(`return ${script}`)() as LayoutReport;
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

  it("reports zero overflow, with every flag clear, for a page that fits", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">Fits exactly</p>`;
    Object.defineProperty(document.documentElement, "scrollWidth", { value: VIEWPORT, configurable: true });

    const report = run();

    expect(report.documentScroll.horizontalOverflowPx).toBe(0);
    expect(report.overflowingElements).toEqual([]);
    expect(report.overflowingElementsTotal).toBe(0);
    expect(report.cssWalkIncomplete).toBeNull();
    expect(report.elementScanIncomplete).toBeNull();
    expect(report.scanTruncated).toBe(false);
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
});

/** Z4: caveats with no runtime detector are on EVERY report, never gated on
 *  some other flag having tripped. */
describe("known gaps are stated unconditionally", () => {
  it("lists @container and closed shadow roots on a clean report whose every flag is clear", () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">plain</p>`;

    const report = run();

    expect(report.cssWalkIncomplete).toBeNull();
    expect(report.elementScanIncomplete).toBeNull();
    expect(report.knownGaps).toEqual([...LAYOUT_REPORT_KNOWN_GAPS]);
    expect(report.knownGaps.some((g) => /@container/.test(g))).toBe(true);
    expect(report.knownGaps.some((g) => /closed shadow roots cannot be detected/i.test(g))).toBe(true);
    expect(report.knownGaps.some((g) => /open shadow roots and inside iframe documents are never measured/i.test(g))).toBe(true);
  });
});

/** Z3: every silent skip counts. One test per early return / catch that can
 *  lose a rule or a sheet; the LOSSLESS ones are argued in the script. */
describe("every silent skip in the CSS walk is counted", () => {
  it("finds an @media nested inside @layer > @supports, and inside another @media", () => {
    const report = withSheets(
      [group([group([media("(max-width: 767px)", [media("(orientation: portrait)")])])]), group([media("print")])],
      ["(max-width: 767px)", "(orientation: portrait)"],
    );

    expect(report.matchingMediaQueries.sort()).toEqual(["(max-width: 767px)", "(orientation: portrait)"]);
    expect(report.matchingMediaQueries).not.toContain("print");
    expect(report.cssWalkIncomplete).toBeNull();
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

  it("bounds the walk by DEPTH and says so", () => {
    let deep: unknown = media("(max-width: 1px)");
    for (let i = 0; i < 40; i++) deep = group([deep]);
    const report = withSheets([deep], ["(max-width: 1px)"]);

    expect(report.matchingMediaQueries).toEqual([]);
    expect(report.cssDepthTruncated).toBe(true);
    expect(report.cssWalkIncomplete).toMatch(/nesting-depth cap/);
    expect(report.cssWalkIncomplete).toMatch(/every rule below those points was skipped/);
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

describe("every silent skip in the element scan is counted", () => {
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
    // the honest limit, and the flag is what makes the zero safe to read.
    expect(report.overflowingElementsTotal).toBe(0);
    expect(report.elementScanIncomplete).toMatch(/does not pierce shadow DOM/);
    expect(report.elementScanIncomplete).toMatch(/1 iframe\(s\)/);
    expect(report.cssWalkIncomplete).toMatch(/iframe\(s\) are on the page/);
  });

  it("walks an open shadow root's adopted stylesheets", () => {
    document.body.innerHTML = `<div id="host" data-rect="0,0,390,20"></div>`;
    const root = (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" });
    Object.defineProperty(root, "adoptedStyleSheets", { value: [group([media("(max-width: 400px)")])], configurable: true });
    const report = withSheets([], ["(max-width: 400px)"]);

    expect(report.matchingMediaQueries).toEqual(["(max-width: 400px)"]);
    expect(report.shadowRootStyleSheets).toBe(1);
  });

  /**
   * Z2 — the reproduction from the final review. Shadow-root sheet discovery
   * happens inside the element loop over the first SCAN nodes, so a host past
   * the cap is never seen and its responsive CSS is never walked. The old code
   * flagged only the ELEMENT scan here and printed a bare zero for @media.
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
 * Z5 — the no-mutation proof.
 *
 * observableState() covers: the serialized light DOM; the innerHTML and
 * adopted-sheet count of every OPEN shadow root; every form field's live
 * value; per-sheet rule counts for document.styleSheets AND
 * document.adoptedStyleSheets (so a replaced adoptedStyleSheets array, a
 * replaceSync, an insertRule/deleteRule all show); window.name; title;
 * designMode; location; history length; focus; scroll; and EVERY own property
 * of window by getOwnPropertyNames + getOwnPropertySymbols — enumerable or
 * not — so Object.defineProperty(window, x, {enumerable:false}) is seen.
 *
 * The INTERCEPT list is a supplement for effects the snapshot cannot diff:
 * scheduling (setTimeout / setInterval / setImmediate / queueMicrotask /
 * requestAnimationFrame / postMessage — a deferred mutation is caught at the
 * point it is SCHEDULED, and the harness also flushes one macrotask plus the
 * microtask queue before the after-snapshot, so a setTimeout(fn, 0) or
 * queueMicrotask(fn) mutation is caught twice), customElements.define (the
 * registry cannot be enumerated), attachShadow (a new CLOSED root would be
 * invisible to the snapshot), and APIs happy-dom does not model.
 *
 * WHAT THIS STILL CANNOT SEE, honestly:
 *   - A deferral through a channel that is neither intercepted nor flushed:
 *     an event listener the page fires later, a MutationObserver /
 *     IntersectionObserver callback (observe() IS intercepted, so registering
 *     one trips the test; a pre-existing observer's callback does not), an
 *     Image/fetch load handler. The script registers no handlers, but that is
 *     a review fact, not something this test proves.
 *   - Mutations whose only effect is unimplemented in happy-dom and leave
 *     nothing to diff: el.animate(), CSS.registerProperty() — intercepted by
 *     name where happy-dom defines the API at all (the intercept no-ops on an
 *     absent host), which is a denylist and only as good as the list.
 *   - Mutation of a CLOSED shadow root the page created before the script
 *     ran: the script has no handle to one, but nor does the snapshot.
 *   - Anything observable only in a real browser: layout/paint side effects,
 *     scroll anchoring, cross-frame effects.
 */
function observableState(): string {
  const win = window as unknown as Record<PropertyKey, unknown>;
  const describeProp = (k: PropertyKey): string => {
    let v: unknown;
    try { v = win[k]; } catch { return `${String(k)}:throws`; }
    const t = typeof v;
    return t === "string" || t === "number" || t === "boolean" ? `${String(k)}=${String(v)}` : `${String(k)}:${t}`;
  };
  const globals = [
    ...Object.getOwnPropertyNames(win).sort().map(describeProp),
    ...Object.getOwnPropertySymbols(win).map((s) => describeProp(s)).sort(),
  ];
  const fields = [...document.querySelectorAll("input, textarea, select")]
    .map((el) => `${el.id}=${(el as HTMLInputElement).value}`);
  const ruleCount = (sheet: CSSStyleSheet): number | string => {
    try { return sheet.cssRules.length; } catch { return "unreadable"; }
  };
  const sheetRuleCounts = [...document.styleSheets].map(ruleCount);
  const adoptedRuleCounts = [...document.adoptedStyleSheets].map(ruleCount);
  const shadowRoots = [...document.querySelectorAll("*")].flatMap((el) => {
    const root = el.shadowRoot;
    return root ? [`${el.tagName}#${el.id}:${root.innerHTML}|adopted=${root.adoptedStyleSheets.length}`] : [];
  });
  const active = document.activeElement as HTMLElement | null;
  return JSON.stringify({
    html: document.documentElement.outerHTML,
    shadowRoots,
    fields,
    sheetRuleCounts,
    adoptedRuleCounts,
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

/** Runs `script` under the full harness. Returns whether the snapshot changed
 *  and which intercepted APIs were called; the caller asserts. */
async function proveReadOnly(script: string): Promise<{ changed: boolean; called: string[] }> {
  // Materialize every sheet BEFORE the intercepts go in: happy-dom builds a
  // <style> element's CSSStyleSheet on the first styleSheets read, via one
  // replaceSync call of its own (verified: exactly one call on first read,
  // none on later reads, and the object is stable and keeps mutations). Read
  // now so that call is the harness's, not attributed to the script.
  void document.styleSheets.length;
  // (happy-dom's ShadowRoot has no styleSheets at all; the script treats an
  // absent list as an empty one.)
  for (const el of document.querySelectorAll("*")) void el.shadowRoot?.styleSheets?.length;
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

  const before = observableState();
  try {
    runScript(script);
  } finally {
    for (const undo of restore) undo();
  }
  // Flush what a deferral could have queued: the microtask queue, then one
  // real macrotask (setTimeout 0 / setImmediate land here).
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { changed: observableState() !== before, called };
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
  it("leaves the observable state byte-identical and calls no intercepted API", async () => {
    mutationPage();

    const outcome = await proveReadOnly(LAYOUT_REPORT_SCRIPT);

    expect(outcome.called).toEqual([]);
    expect(outcome.changed).toBe(false);
  });

  /** Guards the guard: every escape the last review found, plus the ones the
   *  round before it found, must now go red. Each runs the REAL script with
   *  the mutation prepended, so a harness that went blind would pass them. */
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

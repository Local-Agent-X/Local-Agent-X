import { describe, it, expect } from "vitest";
import { extractStructure, tagOverlap, comparePages } from "./page-structure.js";

/**
 * Fixtures reproduce the shape that defeated a 76-turn clone-matching run:
 * ORIGINAL serves a phone a different document than it serves a desktop;
 * CLONE serves one document to both and bolts an override stylesheet on top.
 * The whole point of the tool is that this difference is visible in one call.
 */
const ORIGINAL_DESKTOP = `<!doctype html><html><head>
  <link rel="stylesheet" href="/d-desktop.css">
</head><body>
  <header><h1>Bella Vida</h1></header>
  <section><h2>Welcome</h2></section>
  <section><h2>Our Services</h2></section>
  <section><h2>Meet The Team</h2></section>
  <footer><h3>Contact</h3></footer>
</body></html>`;

// A genuinely separate mobile document: fewer sections, its own stylesheet.
const ORIGINAL_MOBILE = `<!doctype html><html><head>
  <link rel="stylesheet" href="/d-mobile.css" media="only screen and (max-width:767px)">
</head><body>
  <header><h1>Bella Vida</h1></header>
  <section><h2>Welcome</h2></section>
  <section><h2>Our Services</h2></section>
</body></html>`;

// The clone: ONE document for both, plus an override layer.
const CLONE_HTML = `<!doctype html><html><head>
  <link rel="stylesheet" href="assets/css/sheet-1.css">
  <link rel="stylesheet" href="assets/css/mobile-override.css">
</head><body>
  <header><h1>Bella Vida</h1></header>
  <section><h2>Our Services</h2></section>
  <section><h2>Meet The Team</h2></section>
  <footer><h3>Contact</h3></footer>
</body></html>`;

// The real platform this tool was built against emits ZERO rel="stylesheet".
// Its CSS arrives via preload links and inline config, and the DEVICE variant is
// encoded in the filename. A rel-gated extractor reports "no stylesheets" here.
const DUDA_DESKTOP = `<!doctype html><html><head>
  <link rel="preload" as="style" href="//cdn/x/d-css-runtime-desktop-one-package.min.css">
  <script>window.cfg={css:["//cdn/ea911b07_withFlex_1.min.css"]}</script>
</head><body><h1>Bella Vida</h1></body></html>`;

const DUDA_MOBILE = `<!doctype html><html><head>
  <link rel="preload" as="style" href="//cdn/x/d-css-runtime-mobile-one-package.min.css">
  <script>window.cfg={css:["//cdn/ea911b07_withFlex_0.min.css"]}</script>
</head><body><h1>Bella Vida</h1></body></html>`;

describe("extractStructure", () => {
  it("reads headings in document order, markup stripped", () => {
    expect(extractStructure(ORIGINAL_DESKTOP).headings).toEqual([
      "Bella Vida", "Welcome", "Our Services", "Meet The Team", "Contact",
    ]);
  });

  it("reads stylesheet links with their media attribute, and ignores non-stylesheet links", () => {
    const html = `<link rel="preconnect" href="//cdn"><link rel="stylesheet" href="/a.css">` +
      `<link rel="stylesheet" href="/m.css" media="(max-width:767px)"><link rel="icon" href="/f.ico">`;
    expect(extractStructure(html).stylesheets).toEqual([
      { href: "/a.css", media: null },
      { href: "/m.css", media: "(max-width:767px)" },
    ]);
  });

  it("collapses nested markup and entities inside a heading", () => {
    expect(extractStructure(`<h2><span>Our</span>&nbsp;<b>Services</b></h2>`).headings)
      .toEqual(["Our Services"]);
  });

  it("keeps a heading whose tag carries attributes, and is not fooled by a mismatched close", () => {
    expect(extractStructure(`<h1 class="x" data-y="1">Kept</h1><h2>Also</h3>`).headings)
      .toEqual(["Kept"]);
  });
});

describe("tagOverlap", () => {
  it("is 1 for the same elements and 0 when one side is empty", () => {
    expect(tagOverlap(["div", "p"], ["p", "div"])).toBe(1);
    expect(tagOverlap([], [])).toBe(1);
    expect(tagOverlap(["div"], [])).toBe(0);
  });

  it("counts duplicates rather than treating tags as a set", () => {
    // Three divs vs one div is not a full match, which a Set would call 1.
    expect(tagOverlap(["div", "div", "div"], ["div"])).toBeCloseTo(1 / 3);
  });
});

describe("comparePages — the signal that ends a clone-matching task", () => {
  const original = { url: "https://original.example/", desktopHtml: ORIGINAL_DESKTOP, mobileHtml: ORIGINAL_MOBILE };
  const clone = { url: "http://127.0.0.1:7007/clone", desktopHtml: CLONE_HTML, mobileHtml: CLONE_HTML };

  it("separates device-specific delivery from one-document-plus-overrides", () => {
    const r = comparePages(clone, original);
    // The clone hands a phone exactly what it hands a desktop.
    expect(r.a.desktopAndMobileIdentical).toBe(true);
    expect(r.a.desktopVsMobileTagOverlap).toBe(1);
    // The original does not — and says which sections it drops.
    expect(r.b.desktopAndMobileIdentical).toBe(false);
    expect(r.b.desktopVsMobileTagOverlap).toBeLessThan(1);
    expect(r.b.headingsDroppedOnMobile).toEqual(["Meet The Team", "Contact"]);
  });

  it("names the content the clone is missing and the content it should not be showing", () => {
    const r = comparePages(clone, original);
    expect(r.headingsOnlyInB).toEqual(["Welcome"]);            // clone is missing it
    expect(r.headingsOnlyInA).toEqual(["Meet The Team", "Contact"]); // original hides these on mobile
    expect(r.headingDifferenceCount).toBe(3);
  });

  it("lists each phone document's stylesheets so an override layer is visible as data", () => {
    const r = comparePages(clone, original);
    expect(r.a.mobileStylesheets.map(s => s.href)).toEqual([
      "assets/css/sheet-1.css", "assets/css/mobile-override.css",
    ]);
    expect(r.b.mobileStylesheets).toEqual([
      { href: "/d-mobile.css", media: "only screen and (max-width:767px)" },
    ]);
    // Cross-side comparison is by FILENAME, so two sites hosting the same sheet
    // under different paths still compare equal.
    expect(r.mobileStylesheetsOnlyInA).toContain("mobile-override.css");
  });

  it("drives headingDifferenceCount to zero once the phone documents carry the same headings", () => {
    const fixed = { url: "http://127.0.0.1:7007/clone", desktopHtml: CLONE_HTML, mobileHtml: ORIGINAL_MOBILE };
    expect(comparePages(fixed, original).headingDifferenceCount).toBe(0);
  });

  it("reports zero difference for a page compared with itself", () => {
    expect(comparePages(clone, clone).headingDifferenceCount).toBe(0);
    expect(comparePages(clone, clone).mobileTagOverlap).toBe(1);
  });
});

describe("cssReferences — the signal a rel=\"stylesheet\" gate misses", () => {
  it("finds css referenced by preload links and inline script, with no rel=stylesheet anywhere", () => {
    const s = extractStructure(DUDA_MOBILE);
    expect(s.stylesheets).toEqual([]); // nothing declares itself a stylesheet
    expect(s.cssReferences).toEqual([
      "d-css-runtime-mobile-one-package.min.css",
      "ea911b07_withFlex_0.min.css",
    ]);
  });

  it("reduces a url to its filename and de-duplicates", () => {
    const s = extractStructure(`<link href="//cdn/a/x.min.css"><link href="//other/b/x.min.css?v=2">`);
    expect(s.cssReferences).toEqual(["x.min.css"]);
  });

  it("names the per-device stylesheets when an origin serves different css to a phone", () => {
    const r = comparePages(
      { url: "https://orig/", desktopHtml: DUDA_DESKTOP, mobileHtml: DUDA_MOBILE },
      { url: "https://orig/", desktopHtml: DUDA_DESKTOP, mobileHtml: DUDA_MOBILE },
    );
    expect(r.a.cssOnlyOnMobile).toEqual([
      "d-css-runtime-mobile-one-package.min.css",
      "ea911b07_withFlex_0.min.css",
    ]);
    expect(r.a.cssOnlyOnDesktop).toEqual([
      "d-css-runtime-desktop-one-package.min.css",
      "ea911b07_withFlex_1.min.css",
    ]);
  });

  it("reports both empty for an origin that serves one stylesheet set to every device", () => {
    const r = comparePages(
      { url: "http://clone/", desktopHtml: CLONE_HTML, mobileHtml: CLONE_HTML },
      { url: "https://orig/", desktopHtml: DUDA_DESKTOP, mobileHtml: DUDA_MOBILE },
    );
    expect(r.a.cssOnlyOnMobile).toEqual([]);
    expect(r.a.cssOnlyOnDesktop).toEqual([]);
    expect(r.b.cssOnlyOnMobile.length).toBeGreaterThan(0);
  });
});

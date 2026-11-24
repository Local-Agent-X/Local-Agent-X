/**
 * A company's look read from its website's HTML and CSS: the colors it names
 * as its brand, the ones it uses most, its own fonts (not the system stack),
 * and its logo before its favicon. Parsed from saved strings, no network.
 */
import { describe, expect, it } from "vitest";
import { parseSiteBrand } from "./site-brand.js";

const HTML = `<!doctype html><html><head>
<meta name="theme-color" content="#29335C">
<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/touch.png">
<style>:root { --brand-primary: #E4572E; --gray-100: #f4f4f4 } body { font-family: "Montserrat", Arial, sans-serif }</style>
</head><body><header><img class="site-logo" src="/img/nutrishop.svg" alt="NutriShop"><img src="/hero.jpg" alt="Shakes"></header></body></html>`;
const CSS = `.btn { background: #B5D334; color: #fff } .btn:hover { background: #b5d334 } p { font-family: 'Open Sans', system-ui; color: #333333 }
.tag { background: rgb(181, 211, 52) } h1 { font-family: Montserrat, sans-serif }`;

describe("parseSiteBrand", () => {
  const look = parseSiteBrand(HTML, [CSS], "https://nutrishop.example/");

  it("puts the color the site names as its brand first, then the colors it uses most", () => {
    expect(look.colors.primary).toBe("E4572E");
    expect(look.found.slice(0, 3)).toEqual(["E4572E", "29335C", "B5D334"]);
    expect(look.found).not.toContain("333333");
    expect(look.found).not.toContain("F4F4F4");
  });

  it("takes the site's own fonts, not the system stack", () => {
    expect(look.fonts).toEqual({ heading: "Montserrat", body: "Open Sans" });
  });

  it("lists the logo before the touch icon before the favicon, as absolute URLs", () => {
    expect(look.logos).toEqual([
      "https://nutrishop.example/img/nutrishop.svg",
      "https://nutrishop.example/touch.png",
      "https://nutrishop.example/favicon.ico",
    ]);
  });

  it("finds nothing on a page with no styles rather than guessing", () => {
    const bare = parseSiteBrand("<html><body>hi</body></html>", [], "https://x.example/");
    expect(bare.found).toEqual([]);
    expect(bare.colors.primary).toBeUndefined();
    expect(bare.logos).toEqual([]);
  });
});

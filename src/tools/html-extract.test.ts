import { describe, it, expect } from "vitest";
import { extractFromHtml } from "./html-extract.js";

describe("extractFromHtml", () => {
  it("extracts title, description, JSON-LD, and visible text from an article", () => {
    const html = `<!doctype html><html><head>
      <title>Markets rally on rate cut &amp; oil dip</title>
      <meta name="description" content="Stocks climbed Tuesday.">
      <script type="application/ld+json">{"@type":"NewsArticle","headline":"Markets rally"}</script>
      <script>var tracking = 1;</script><style>.x{color:red}</style>
      </head><body><nav>Home About</nav><article><h1>Markets rally</h1>
      <p>Stocks climbed on Tuesday after the central bank cut rates.</p></article></body></html>`;
    const r = extractFromHtml(html);
    expect(r.looksEmpty).toBe(false);
    expect(r.content).toContain("# Markets rally on rate cut & oil dip"); // entity decoded
    expect(r.content).toContain("Stocks climbed Tuesday.");
    expect(r.content).toContain('"headline":"Markets rally"'); // JSON-LD preserved raw
    expect(r.content).toContain("Stocks climbed on Tuesday after the central bank cut rates.");
    expect(r.content).not.toContain("var tracking"); // script dropped
    expect(r.content).not.toContain("color:red"); // style dropped
  });

  it("flags a substantial JS shell (big markup, no readable text) as looksEmpty", () => {
    // A real shell is large — inline/referenced bundles — but renders its content
    // client-side, so the static HTML has ~nothing to read.
    const bundle = `;(function(){${"var a=1;".repeat(400)}})();`; // ~2.8KB of JS
    const shell = `<!doctype html><html><head><title>App</title>
      <script>${bundle}</script></head>
      <body><div id="root"></div><noscript>You need JavaScript.</noscript></body></html>`;
    const r = extractFromHtml(shell);
    expect(r.looksEmpty).toBe(true);
  });

  it("does NOT flag a genuinely short static page as a shell", () => {
    // example.com-class: little text, but it's the WHOLE page, all server-rendered.
    const small = `<!doctype html><html><head><title>Example Domain</title></head>
      <body><h1>Example Domain</h1><p>This domain is for use in examples.</p></body></html>`;
    const r = extractFromHtml(small);
    expect(r.looksEmpty).toBe(false);
    expect(r.content).toContain("This domain is for use in examples.");
  });

  it("does NOT flag a page as empty when JSON-LD carries the content", () => {
    // Sparse visible text, but the structured data IS the answer (e.g. a product).
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"19.99"}}</script>
      </head><body><div id="app"></div></body></html>`;
    const r = extractFromHtml(html);
    expect(r.looksEmpty).toBe(false);
    expect(r.content).toContain('"price":"19.99"');
  });

  it("reads meta content regardless of attribute order", () => {
    const html = `<html><head><meta content="Reversed order works" property="og:title"></head><body>x</body></html>`;
    expect(extractFromHtml(html).content).toContain("# Reversed order works");
  });
});

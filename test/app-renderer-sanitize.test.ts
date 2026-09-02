import { describe, it, expect } from "vitest";
import {
  sanitizeHtml,
  escapeHtml,
  htmlToText,
  decodeHtmlEntities,
} from "../src/app-renderer/sanitize.js";

// Regression suite for the sanitize.ts rewrite: the old blocklist regex
// `sanitizeHtml` was XSS-bypassable (nested tags, attribute tricks). The new
// implementation escapes everything first, then re-permits only attribute-free
// safe tags — complete by construction.
describe("app-renderer sanitizeHtml (allowlist rewrite)", () => {
  it("never emits a live script tag (content survives only as inert text)", () => {
    const out = sanitizeHtml("<script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("neutralizes the nested-tag bypass the old blocklist regex missed", () => {
    // A single blocklist pass over `<scr<script>ipt>` leaves a live `<script>`.
    // Escaping-first makes that impossible.
    const out = sanitizeHtml("<scr<script>ipt>alert(1)</scr</script>ipt>");
    expect(out).not.toContain("<script");
  });

  it("does not emit a tag that carries attributes as live markup", () => {
    const out = sanitizeHtml('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
  });

  it("emits no live tag bearing an event handler", () => {
    const out = sanitizeHtml('<b onclick="steal()">x</b>');
    // No live element carrying an on*= attribute (escaped text is inert).
    expect(out).not.toMatch(/<\w+[^>]*\son\w+=/i);
  });

  it("keeps attribute-free safe formatting tags intact", () => {
    expect(sanitizeHtml("<b>bold</b> and <i>it</i>")).toBe(
      "<b>bold</b> and <i>it</i>",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes all five HTML metacharacters in ampersand-first order", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;",
    );
  });
});

describe("decodeHtmlEntities / htmlToText", () => {
  it("decodes the ampersand entity last so it does not double-decode", () => {
    // `&amp;lt;` must round-trip to the literal `&lt;`, NOT to `<`.
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("strips tags and decodes entities to plain text", () => {
    expect(htmlToText("<b>hi</b> &amp; <i>bye</i>")).toBe("hi & bye");
  });

  it("strips tags to a fixpoint (split/nested tags cannot survive)", () => {
    expect(htmlToText("a<<b>>c")).not.toContain("<");
  });

  it("decodes decimal and hex numeric character references", () => {
    expect(decodeHtmlEntities("It&#8217;s")).toBe("It’s");
    expect(decodeHtmlEntities("It&#x2019;s")).toBe("It’s");
    expect(decodeHtmlEntities("caf&#233;")).toBe("café");
  });

  it("decodes common named typographic entities", () => {
    expect(decodeHtmlEntities("&rsquo;&lsquo;&ldquo;&rdquo;&mdash;&ndash;&hellip;")).toBe(
      "’‘“”—–…",
    );
    expect(decodeHtmlEntities("&copy; &trade; 5&times;4 90&deg;")).toBe(
      "© ™ 5×4 90°",
    );
  });

  it("is single-pass: &amp;amp; → &amp;, never cascading to &", () => {
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeHtmlEntities("&amp;#8217;")).toBe("&#8217;");
    // Replacement text is never rescanned: the & produced from &#38; cannot
    // combine with the following `lt;` into a second decode.
    expect(decodeHtmlEntities("&#38;lt;")).toBe("&lt;");
  });

  it("leaves invalid numeric references literal (surrogate, out of range, control)", () => {
    expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
    expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeHtmlEntities("&#7;")).toBe("&#7;");
    expect(decodeHtmlEntities("&#x9F;")).toBe("&#x9F;");
  });

  it("leaves unknown names literal — including prototype property names", () => {
    expect(decodeHtmlEntities("&nosuch;")).toBe("&nosuch;");
    expect(decodeHtmlEntities("&constructor;")).toBe("&constructor;");
    expect(decodeHtmlEntities("&hasOwnProperty;")).toBe("&hasOwnProperty;");
  });

  it("decodes astral-plane references via fromCodePoint", () => {
    expect(decodeHtmlEntities("&#128512;")).toBe("\u{1F600}");
  });
});

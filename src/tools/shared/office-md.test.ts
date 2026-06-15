import { describe, it, expect } from "vitest";
import { cleanText, parseInline, parseMarkdown, toPlainText, spansToPlain } from "./office-md.js";

describe("parseMarkdown — never crashes on missing body (collapsed-tool create without content)", () => {
  it("returns an array for undefined instead of throwing on .split", () => {
    // Regression: pdf_create (via the collapsed `pdf` tool) reached parseMarkdown
    // with undefined content → "Cannot read properties of undefined (reading 'split')".
    expect(() => parseMarkdown(undefined as unknown as string)).not.toThrow();
    expect(Array.isArray(parseMarkdown(undefined as unknown as string))).toBe(true);
    // No real content blocks (no code/para/heading) — nothing to render.
    expect(parseMarkdown(undefined as unknown as string).some(b => b.kind === "code" || b.kind === "para")).toBe(false);
  });
  it("does not throw on an empty string", () => {
    expect(() => parseMarkdown("")).not.toThrow();
    expect(Array.isArray(parseMarkdown(""))).toBe(true);
  });
});

describe("cleanText — no markup leaks", () => {
  it("strips HTML tags", () => {
    expect(cleanText("<div>Hi</div>")).toBe("Hi");
    expect(cleanText('<span style="color:red">x</span>')).toBe("x");
    expect(cleanText("a<br/>b")).toBe("ab");
    expect(cleanText("<p>one</p><p>two</p>")).toBe("onetwo");
  });
  it("strips escaped tags and HTML comments", () => {
    expect(cleanText("&lt;div&gt;x&lt;/div&gt;")).toBe("x");
    expect(cleanText("a<!-- hidden -->b")).toBe("ab");
  });
  it("decodes entities", () => {
    expect(cleanText("A &amp; B")).toBe("A & B");
    expect(cleanText("x&nbsp;y")).toBe("x y");
  });
  it("removes zero-width characters", () => {
    expect(cleanText("a​b﻿c")).toBe("abc");
  });
  it("PRESERVES legitimate < and > in prose (not real tags)", () => {
    expect(cleanText("if a < b and c > d then")).toBe("if a < b and c > d then");
    expect(cleanText("x <= 5")).toBe("x <= 5");
  });
});

describe("parseInline — consumes markdown markers", () => {
  it("parses bold/italic/code/strike/link and leaves no markers", () => {
    const spans = parseInline("**bold** and *it* and `c` and ~~s~~ and [t](http://u.co)");
    const joined = JSON.stringify(spans);
    expect(spans.find((s) => s.bold)?.text).toBe("bold");
    expect(spans.find((s) => s.italic)?.text).toBe("it");
    expect(spans.find((s) => s.code)?.text).toBe("c");
    expect(spans.find((s) => s.strike)?.text).toBe("s");
    expect(spans.find((s) => s.href)?.href).toBe("http://u.co");
    expect(joined).not.toMatch(/\*\*|~~/); // no raw markers survived
  });
  it("strips HTML inside inline text", () => {
    const spans = parseInline("hello <div>there</div> **bold<br>**");
    expect(spansToPlain(spans)).toBe("hello there bold");
  });
});

describe("parseMarkdown — block structure", () => {
  it("parses a table", () => {
    const blocks = parseMarkdown("| Name | Rev |\n|---|---|\n| Acme | 5 |\n| Globex | 9 |");
    const table = blocks.find((b) => b.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind === "table") {
      expect(table.header).toHaveLength(2);
      expect(table.rows).toHaveLength(2);
      expect(spansToPlain(table.rows[0][0])).toBe("Acme");
    }
  });
  it("parses headings, ordered/bullet lists, quote, code, hr", () => {
    const blocks = parseMarkdown("# H1\n1. first\n2. second\n- bullet\n> quote\n---\n```\ncode <div>\n```");
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("heading");
    expect(kinds.filter((k) => k === "ordered")).toHaveLength(2);
    expect(kinds).toContain("bullet");
    expect(kinds).toContain("quote");
    expect(kinds).toContain("hr");
    const code = blocks.find((b) => b.kind === "code");
    // code is preserved VERBATIM (literal code is content, not a leak)
    if (code?.kind === "code") expect(code.text).toContain("<div>");
  });
});

describe("toPlainText — flatten for plain sinks", () => {
  it("drops block + inline markers and HTML", () => {
    const out = toPlainText("# Title\n- item **bold** <div>x</div>\n[link](http://u)");
    expect(out).toContain("Title");
    expect(out).toContain("item bold x");
    expect(out).toContain("link");
    expect(out).not.toMatch(/[#*]|<div>|\]\(/);
  });
});

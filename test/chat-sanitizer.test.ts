// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let sanitizeHtml: (h: string) => string;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "public", "js", "shared-escape.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { sanitizeHtml, sanitizeUrl, esc };");
  ({ sanitizeHtml } = factory());
});

describe("sanitizeHtml — XSS neutralization", () => {
  it("drops <script> entirely", () => {
    expect(sanitizeHtml("<script>alert(1)</script>")).not.toContain("<script");
  });

  it("strips onerror from img", () => {
    const out = sanitizeHtml("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("onerror");
  });

  it("rewrites javascript: href to #", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });

  it("drops style with url(javascript:...)", () => {
    const out = sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>');
    expect(out).not.toContain("style");
    expect(out).not.toContain("url(");
  });

  it("drops <iframe>", () => {
    expect(sanitizeHtml("<iframe src=//evil></iframe>")).not.toContain("<iframe");
  });

  it("neutralizes mutation-XSS <svg><script>", () => {
    const out = sanitizeHtml("<svg><script>alert(1)</script></svg>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<svg");
  });

  it("drops onclick from allowed tag but keeps content", () => {
    const out = sanitizeHtml('<p onclick="x()">hi</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("<p>hi</p>");
  });

  it("drops <script> child of an unwrapped unknown tag", () => {
    const out = sanitizeHtml("<foo><script>alert(1)</script></foo>");
    expect(out).not.toContain("<script");
  });

  it("drops <iframe> child of an unwrapped unknown tag", () => {
    const out = sanitizeHtml('<unknownwrap><iframe src="//evil"></iframe></unknownwrap>');
    expect(out).not.toContain("<iframe");
  });

  it("unwraps nested unknown wrappers and keeps inner text", () => {
    const out = sanitizeHtml("<x-a><x-b>hello</x-b></x-a>");
    expect(out).toContain("hello");
  });
});

describe("sanitizeHtml — legit markdown survives", () => {
  it("keeps file-download anchor href + classes", () => {
    const html = '<a href="/files/report.docx?token=abc" class="md-link file-download">r</a>';
    const out = sanitizeHtml(html);
    expect(out).toContain('href="/files/report.docx?token=abc"');
    expect(out).toContain("md-link");
    expect(out).toContain("file-download");
  });

  it("preserves table/th and inline style", () => {
    const html = '<table style="border-collapse:collapse"><thead><tr><th style="padding:6px">A</th></tr></thead></table>';
    const out = sanitizeHtml(html);
    expect(out).toContain("<table");
    expect(out).toContain("<th");
    expect(out).toContain("border-collapse:collapse");
    expect(out).toContain("padding:6px");
  });

  it("preserves blockquote style with var()", () => {
    const html = '<blockquote style="border-left:3px solid var(--accent-dim)">q</blockquote>';
    const out = sanitizeHtml(html);
    expect(out).toContain("border-left:3px solid var(--accent-dim)");
  });

  it("preserves inline image src/alt/class", () => {
    const html = '<img src="https://x.com/a.png" alt="image" class="inline-chat-img">';
    const out = sanitizeHtml(html);
    expect(out).toContain('src="https://x.com/a.png"');
    expect(out).toContain('alt="image"');
    expect(out).toContain("inline-chat-img");
  });

  it("preserves plain bold paragraph", () => {
    const html = "<p>hello <strong>world</strong></p>";
    expect(sanitizeHtml(html)).toBe("<p>hello <strong>world</strong></p>");
  });

  it("keeps data-agent-id on inline agent card", () => {
    const out = sanitizeHtml('<div class="agent-inline-card" data-agent-id="x">y</div>');
    expect(out).toContain('data-agent-id="x"');
    expect(out).toContain("agent-inline-card");
  });

  it("keeps data-* but drops onclick", () => {
    const out = sanitizeHtml('<div onclick="x()" data-agent-id="1">z</div>');
    expect(out).toContain('data-agent-id="1"');
    expect(out).not.toContain("onclick");
  });
});

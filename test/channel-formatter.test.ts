import { describe, it, expect } from "vitest";
import { formatForChannel } from "../src/channel-formatter.js";

describe("formatForChannel — telegram MarkdownV2", () => {
  it("escapes reserved characters in plain text", () => {
    const [out] = formatForChannel("Hello world. Ready!", "telegram");
    expect(out).toBe("Hello world\\. Ready\\!");
  });

  it("passes code spans through raw without escaping their contents", () => {
    const [out] = formatForChannel("use `a.b()` now!", "telegram");
    expect(out).toContain("`a.b()`");
    expect(out.endsWith("now\\!")).toBe(true);
  });

  it("does not leak the internal code-span placeholder (regression)", () => {
    const [out] = formatForChannel("run `npm i` then `x.y`", "telegram");
    expect(out).not.toContain("XINLINECODE");
    expect(out).not.toContain("XCODEBLOCK");
    expect(out).toContain("`npm i`");
    expect(out).toContain("`x.y`");
  });

  it("preserves fenced code blocks raw", () => {
    const [out] = formatForChannel("```\nconst x = 1;\n```", "telegram");
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("\\=");
  });
});

describe("formatForChannel — whatsapp", () => {
  it("converts **bold** to *bold*", () => {
    const [out] = formatForChannel("this is **bold** text", "whatsapp");
    expect(out).toBe("this is *bold* text");
  });

  it("converts markdown headers to bold", () => {
    const [out] = formatForChannel("## Heading", "whatsapp");
    expect(out).toBe("*Heading*");
  });

  it("rewrites markdown links to 'text: url'", () => {
    const [out] = formatForChannel("see [the docs](https://x.io)", "whatsapp");
    expect(out).toBe("see the docs: https://x.io");
  });
});

describe("formatForChannel — chunking", () => {
  it("returns a single chunk when under the channel limit", () => {
    expect(formatForChannel("short", "whatsapp")).toHaveLength(1);
  });

  it("splits long text into multiple chunks with continuation markers", () => {
    const long = Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n");
    const chunks = formatForChannel(long, "whatsapp");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain(`(1/${chunks.length})`);
  });

  it("never chunks web (unlimited) output", () => {
    const long = "x".repeat(20000);
    expect(formatForChannel(long, "web")).toHaveLength(1);
  });
});

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

  it("restores code containing $ sequences verbatim (HE-4 regression)", () => {
    // String-form replace interprets $$, $&, $' in the replacement — code
    // like `echo $$` was corrupted and $& re-injected the placeholder.
    const [out] = formatForChannel("run:\n```bash\necho $$ and $& and $' here\n```", "telegram");
    expect(out).toContain("echo $$ and $& and $' here");
    expect(out).not.toContain("XCODEBLOCK");
  });

  it("restores inline code containing $ sequences verbatim (HE-4 regression)", () => {
    const [out] = formatForChannel("pid is `echo $$` ok", "telegram");
    expect(out).toContain("`echo $$`");
    expect(out).not.toContain("XINLINECODE");
  });

  it("converts **bold** to MarkdownV2 *bold* instead of escaping it (HE-7 regression)", () => {
    const [out] = formatForChannel("this is **bold** text", "telegram");
    expect(out).toBe("this is *bold* text");
  });

  it("keeps [link](url) as a MarkdownV2 link instead of escaping it (HE-7 regression)", () => {
    const [out] = formatForChannel("see [the docs](https://x.io/a)", "telegram");
    expect(out).toBe("see [the docs](https://x.io/a)");
  });

  it("converts ## headers to bold lines with escaped inner text (HE-7 regression)", () => {
    const [out] = formatForChannel("## Heading v1.2", "telegram");
    expect(out).toBe("*Heading v1\\.2*");
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

  it("does not treat ** inside code as bold markers (HE-8 regression)", () => {
    // Pre-fix, the **(.+?)** pass ran over unmasked code and turned
    // Python x**2 into x*2.
    const [out] = formatForChannel("```python\ny = x**2 + x**3\n```", "whatsapp");
    expect(out).toContain("x**2 + x**3");
  });

  it("leaves inline code untouched by styling passes (HE-8 regression)", () => {
    const [out] = formatForChannel("square via `x**2` here", "whatsapp");
    expect(out).toContain("`x**2`");
  });
});

describe("formatForChannel — plain (cli)", () => {
  it("does not strip underscores inside code (HE-8 regression)", () => {
    // Pre-fix, the _(.+?)_ pass ran over unmasked code and mangled
    // snake_case / dunder identifiers (__init__ → init).
    const [out] = formatForChannel("call `__init__` first", "cli");
    expect(out).toContain("`__init__`");
  });

  it("keeps fenced code content intact while dropping fence markers", () => {
    const [out] = formatForChannel("```\na_b = c_d\n```", "cli");
    expect(out).toContain("a_b = c_d");
    expect(out).not.toContain("```");
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

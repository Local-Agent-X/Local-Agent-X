import { describe, it, expect } from "vitest";
import {
  filterStreamDelta,
  stripToolCallBlocks,
  cleanUrls,
} from "../src/anthropic-client/parse.js";

// ── filterStreamDelta ────────────────────────────────────────────────────

describe("filterStreamDelta — JSON tool-call shape", () => {
  it("passes plain text through when not suppressing", () => {
    const r = filterStreamDelta("hello world", false);
    expect(r.text).toBe("hello world");
    expect(r.suppress).toBeUndefined();
  });

  it("starts suppression on ```json fence", () => {
    const r = filterStreamDelta("```json", false);
    expect(r.suppress).toBe(true);
  });

  it("starts suppression on raw {\"tool_calls\" prefix", () => {
    const r = filterStreamDelta('{"tool_calls": [', false);
    expect(r.suppress).toBe(true);
  });

  it("does NOT start suppression on a bare ``` code-fence — a legit fenced block must survive", () => {
    // Suppressing here latched and swallowed the whole code block that
    // followed. Only ```json / {"tool_calls" opens a tool-call block.
    const r = filterStreamDelta("```", false);
    expect(r.suppress).toBeUndefined();
    expect(r.text).toBe("```");
  });

  it("does NOT start suppression on inline backticks in prose", () => {
    const r = filterStreamDelta("the `foo` variable is set", false);
    expect(r.text).toBe("the `foo` variable is set");
  });

  it("ends suppression on closing ``` fence and emits empty text", () => {
    const r = filterStreamDelta("```", true);
    expect(r.text).toBe("");
  });

  it("ends suppression on JSON close `}\\n`", () => {
    const r = filterStreamDelta("}\n", true);
    expect(r.text).toBe("");
  });

  it("keeps suppressing mid-block deltas", () => {
    const r = filterStreamDelta('"name":"foo",', true);
    expect(r.suppress).toBe(true);
  });
});

describe("filterStreamDelta — XML tool-call shape", () => {
  it("starts suppression on <tool_use> open tag", () => {
    const r = filterStreamDelta("<tool_use>", false);
    expect(r.suppress).toBe(true);
  });

  it("starts suppression on <function_calls> open tag", () => {
    const r = filterStreamDelta("<function_calls>", false);
    expect(r.suppress).toBe(true);
  });

  it("ends suppression on </tool_use> close tag", () => {
    const r = filterStreamDelta("</tool_use>", true);
    expect(r.text).toBe("");
  });

  it("ends suppression on </function_calls> close tag", () => {
    const r = filterStreamDelta("</function_calls>", true);
    expect(r.text).toBe("");
  });

  it("keeps suppressing through <parameter> children", () => {
    const r = filterStreamDelta('<parameter name="task">', true);
    expect(r.suppress).toBe(true);
  });

  it("starts suppression when XML tag arrives glued to surrounding text", () => {
    const r = filterStreamDelta("Sure, let me <tool_use>", false);
    expect(r.suppress).toBe(true);
  });
});

// ── stripToolCallBlocks ─────────────────────────────────────────────────

describe("stripToolCallBlocks — JSON shapes", () => {
  it("removes a fenced ```json tool_calls block", () => {
    const input =
      "Here you go.\n\n```json\n" +
      '{"tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n' +
      "```\n\nDone.";
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
    expect(out).toContain("Here you go.");
    expect(out).toContain("Done.");
  });

  it("removes a fenced block with no `json` language tag", () => {
    const input =
      'before\n```\n{"tool_calls":[{"name":"x","arguments":{}}]}\n```\nafter';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
  });

  it("removes raw inline tool_calls JSON", () => {
    const input =
      'pre {"tool_calls":[{"name":"y","arguments":{}}]} post';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
    expect(out).toContain("pre");
    expect(out).toContain("post");
  });
});

describe("stripToolCallBlocks — XML shapes", () => {
  it("removes <tool_use>...</tool_use> blocks", () => {
    const input =
      'reply text <tool_use><parameter name="path">a.ts</parameter></tool_use> trailing';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("<tool_use>");
    expect(out).not.toContain("</tool_use>");
    expect(out).toContain("reply text");
    expect(out).toContain("trailing");
  });

  it("removes <function_calls>...</function_calls> blocks", () => {
    const input =
      "head <function_calls>blah <parameter name=\"x\">1</parameter></function_calls> tail";
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("<function_calls>");
    expect(out).not.toContain("blah");
    expect(out).toContain("head");
    expect(out).toContain("tail");
  });

  it("strips orphaned <parameter> blocks if outer wrapper missing", () => {
    const input =
      'text <parameter name="prompt">hello</parameter> more text';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("<parameter");
    expect(out).toContain("text");
    expect(out).toContain("more text");
  });

  it("removes multi-line XML blocks", () => {
    const input = [
      "Sure thing.",
      "<tool_use>",
      '<parameter name="task">',
      "do the thing",
      "</parameter>",
      "</tool_use>",
      "Result coming up.",
    ].join("\n");
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("<tool_use>");
    expect(out).not.toContain("<parameter");
    expect(out).not.toContain("do the thing");
    expect(out).toContain("Sure thing.");
    expect(out).toContain("Result coming up.");
  });

  it("returns trimmed output (leading/trailing whitespace removed)", () => {
    const input = "\n\n  hello  \n\n";
    expect(stripToolCallBlocks(input)).toBe("hello");
  });

  it("is a no-op when no tool blocks present", () => {
    const input = "plain reply with `code` and a [link](http://x).";
    expect(stripToolCallBlocks(input)).toBe(input);
  });

  it("removes both shapes if they coexist", () => {
    const input =
      "ok " +
      '```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n``` ' +
      '<tool_use><parameter name="b">v</parameter></tool_use> done';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
    expect(out).not.toContain("<tool_use>");
    expect(out).not.toContain("<parameter");
    expect(out).toContain("ok");
    expect(out).toContain("done");
  });
});

// ── cleanUrls ───────────────────────────────────────────────────────────

describe("cleanUrls", () => {
  it("strips trailing punctuation from a URL at end of sentence", () => {
    const out = cleanUrls("see https://example.com/foo. ok");
    expect(out).toBe("see https://example.com/foo ok");
  });

  it("preserves URLs with no trailing punctuation", () => {
    const out = cleanUrls("see https://example.com/foo and here");
    expect(out).toBe("see https://example.com/foo and here");
  });

  it("strips multiple trailing punct (e.g. '!?.')", () => {
    const out = cleanUrls("wow https://x.com/path?!\nnext");
    expect(out).toBe("wow https://x.com/path?\nnext");
  });

  it("leaves URLs followed by ) or ] alone (already URL-stoppers)", () => {
    const out = cleanUrls("(see https://x.com/p) here");
    expect(out).toBe("(see https://x.com/p) here");
  });

  it("strips trailing punct from each URL when multiple URLs share a line", () => {
    const out = cleanUrls("see https://a.com/x. and https://b.com/y, ok");
    expect(out).toBe("see https://a.com/x and https://b.com/y ok");
  });

  it("preserves URL with query string (? is part of the URL, not trailing punct)", () => {
    const out = cleanUrls("docs at https://x.com/path?foo=1&bar=2 here");
    expect(out).toBe("docs at https://x.com/path?foo=1&bar=2 here");
  });

  it("preserves URL with fragment", () => {
    const out = cleanUrls("see https://x.com/path#section now");
    expect(out).toBe("see https://x.com/path#section now");
  });

  it("strips trailing punct when URL ends a line (regex tail accepts \\n via \\s)", () => {
    const out = cleanUrls("link: https://x.com/path.\nnext line");
    expect(out).toBe("link: https://x.com/path\nnext line");
  });

  it("ignores http URLs without trailing punct (verifies no false positives)", () => {
    const out = cleanUrls("legacy http://example.com works fine here");
    expect(out).toBe("legacy http://example.com works fine here");
  });

  it("does not touch a string with no URLs at all", () => {
    const out = cleanUrls("just normal sentence with a period.");
    expect(out).toBe("just normal sentence with a period.");
  });
});

describe("stripToolCallBlocks — Anthropic native shape", () => {
  it("strips the bare envelope when validToolNames are provided", () => {
    const text = `Hello{"name":"agent_spawn","input":{"agent":"researcher"}}World`;
    const out = stripToolCallBlocks(text, new Set(["agent_spawn"]));
    expect(out).toBe("HelloWorld");
  });

  it("leaves the JSON alone if no validToolNames are provided (back-compat)", () => {
    const text = `Hello{"name":"agent_spawn","input":{"agent":"researcher"}}World`;
    const out = stripToolCallBlocks(text);
    expect(out).toBe(text.trim());
  });

  it("leaves the JSON alone for unknown tool names", () => {
    const text = `Hello{"name":"made_up","input":{"x":1}}World`;
    const out = stripToolCallBlocks(text, new Set(["agent_spawn"]));
    expect(out).toBe(text.trim());
  });
});

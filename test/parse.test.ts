import { describe, it, expect } from "vitest";
import {
  filterStreamDelta,
  stripToolCallBlocks,
  parseToolCalls,
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

  it("starts suppression on bare ``` code-fence start", () => {
    const r = filterStreamDelta("```", false);
    expect(r.suppress).toBe(true);
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

// ── parseToolCalls ──────────────────────────────────────────────────────

describe("parseToolCalls", () => {
  it("returns empty array when no tool_calls present", () => {
    expect(parseToolCalls("just text")).toEqual([]);
  });

  it("parses a single fenced tool_calls block", () => {
    const text =
      "```json\n" +
      '{"tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n' +
      "```";
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read");
    expect(calls[0].arguments).toEqual({ path: "a.ts" });
  });

  it("parses multiple fenced tool_calls blocks in order", () => {
    const text = [
      "first:",
      '```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n```',
      "second:",
      '```json\n{"tool_calls":[{"name":"b","arguments":{"x":1}}]}\n```',
    ].join("\n");
    const calls = parseToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
    expect(calls[1].arguments).toEqual({ x: 1 });
  });

  it("falls back to raw JSON when no fenced blocks", () => {
    const text =
      'lead-in {"tool_calls":[{"name":"raw","arguments":{"k":"v"}}]} trailing';
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("raw");
  });

  it("ignores malformed JSON without throwing", () => {
    const text = "```json\n{not valid json\n```";
    expect(() => parseToolCalls(text)).not.toThrow();
    expect(parseToolCalls(text)).toEqual([]);
  });

  it("defaults arguments to {} when missing", () => {
    const text = '```json\n{"tool_calls":[{"name":"noargs"}]}\n```';
    const calls = parseToolCalls(text);
    expect(calls[0].arguments).toEqual({});
  });

  it("skips entries without a name", () => {
    const text =
      '```json\n{"tool_calls":[{"arguments":{}},{"name":"keep","arguments":{}}]}\n```';
    const calls = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("keep");
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
});

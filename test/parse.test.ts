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

  it("returns ONLY fenced calls when both fenced and raw forms coexist (fenced takes precedence)", () => {
    // Documents the existing if-results-then-return-early branch: once any
    // fenced call parses, the raw fallback never runs. Mixed-form replies
    // (rare but seen) drop the raw entry on purpose.
    const text =
      '```json\n{"tool_calls":[{"name":"fenced","arguments":{}}]}\n```' +
      ' some prose ' +
      '{"tool_calls":[{"name":"raw","arguments":{}}]}';
    const calls = parseToolCalls(text);
    expect(calls.map(c => c.name)).toEqual(["fenced"]);
  });

  it("extracts multiple tool entries from a single tool_calls array", () => {
    const text =
      '```json\n{"tool_calls":[' +
      '{"name":"first","arguments":{"a":1}},' +
      '{"name":"second","arguments":{"b":2}},' +
      '{"name":"third","arguments":{}}' +
      ']}\n```';
    const calls = parseToolCalls(text);
    expect(calls.map(c => c.name)).toEqual(["first", "second", "third"]);
    expect(calls[0].arguments).toEqual({ a: 1 });
    expect(calls[1].arguments).toEqual({ b: 2 });
  });

  it("preserves nested object/array argument shapes", () => {
    const text =
      '```json\n{"tool_calls":[{"name":"complex","arguments":' +
      '{"nested":{"deep":[1,2,{"k":"v"}]},"flag":true}}]}\n```';
    const calls = parseToolCalls(text);
    expect(calls[0].arguments).toEqual({
      nested: { deep: [1, 2, { k: "v" }] },
      flag: true,
    });
  });

  it("returns [] when fenced block is present but its tool_calls is not an array", () => {
    const text = '```json\n{"tool_calls":"not-an-array"}\n```';
    expect(parseToolCalls(text)).toEqual([]);
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

// ── parseToolCalls — Anthropic native shape (the smoke regression) ─────

describe("parseToolCalls — Anthropic native shape {\"name\":..,\"input\":..}", () => {
  it("extracts a known tool call emitted as bare Anthropic native shape", () => {
    const text = `{"name":"agent_spawn","input":{"agent":"researcher","task":"what is the capital of France"}}`;
    const out = parseToolCalls(text, new Set(["agent_spawn"]));
    expect(out).toEqual([
      { name: "agent_spawn", arguments: { agent: "researcher", task: "what is the capital of France" } },
    ]);
  });

  it("ignores Anthropic-shape JSON for an unknown tool name", () => {
    const text = `{"name":"made_up_tool","input":{"x":1}}`;
    const out = parseToolCalls(text, new Set(["agent_spawn", "browser"]));
    expect(out).toEqual([]);
  });

  it("returns nothing when no validToolNames are passed", () => {
    const text = `{"name":"agent_spawn","input":{"agent":"researcher"}}`;
    const out = parseToolCalls(text);
    expect(out).toEqual([]);
  });

  it("handles nested input objects via brace-balanced scan", () => {
    const text = `{"name":"web_fetch","input":{"url":"https://x.com","headers":{"X-Foo":"bar"}}}`;
    const out = parseToolCalls(text, new Set(["web_fetch"]));
    expect(out).toEqual([{ name: "web_fetch", arguments: { url: "https://x.com", headers: { "X-Foo": "bar" } } }]);
  });

  it("extracts the call when wrapped in prose (model self-correction case)", () => {
    const text = `{"name":"agent_spawn","input":{"agent":"researcher","task":"x"}}\n\nWait — I need to actually call the tool properly.`;
    const out = parseToolCalls(text, new Set(["agent_spawn"]));
    expect(out).toEqual([{ name: "agent_spawn", arguments: { agent: "researcher", task: "x" } }]);
  });

  it("prefers OpenAI envelope when both shapes appear (envelope wins via early return)", () => {
    const text = `{"tool_calls":[{"name":"first","arguments":{"x":1}}]}\nAlso: {"name":"second","input":{"y":2}}`;
    const out = parseToolCalls(text, new Set(["first", "second"]));
    expect(out).toEqual([{ name: "first", arguments: { x: 1 } }]);
  });

  it("does not synthesize calls from quoted JSON inside string values", () => {
    // The whole string is one big quoted value — nothing should match because
    // the scanner sees an outer `"` first.
    const text = `Example payload: "{\\"name\\":\\"agent_spawn\\",\\"input\\":{}}"`;
    const out = parseToolCalls(text, new Set(["agent_spawn"]));
    expect(out).toEqual([]);
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

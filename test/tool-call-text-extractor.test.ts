/**
 * Tests for the tool-call-from-text fallback extractor.
 * Triggered by qwen3-next:80b + gpt-oss:20b leaking tool calls as
 * raw JSON in content (live failure 2026-05-12).
 */

import { describe, it, expect } from "vitest";
import { extractToolCallsFromText } from "../src/canonical-loop/adapters/tool-call-text-extractor.js";

const TOOLS = new Set(["browser", "read", "write", "bash", "edit"]);

describe("extractToolCallsFromText — full envelope pattern", () => {
  it("extracts a bare OpenAI-shape envelope", () => {
    const text = '{"name": "browser", "arguments": {"action": "click", "ref": 49}}';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ action: "click", ref: 49 });
    expect(remainingText).toBe("");
  });

  it("ignores envelopes for unknown tools", () => {
    const text = '{"name": "unknown_tool", "arguments": {"x": 1}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("strips a ```json code fence wrapper", () => {
    const text = '```json\n{"name": "read", "arguments": {"path": "foo.txt"}}\n```';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
  });

  it("accepts arguments as a serialized JSON string", () => {
    const text = '{"name": "browser", "arguments": "{\\"action\\":\\"snapshot\\"}"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].arguments).toBe('{"action":"snapshot"}');
  });
});

describe("extractToolCallsFromText — browser shorthand", () => {
  it("extracts {action, ref} as a browser tool call", () => {
    const text = '{"action":"click","ref":49}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
    expect(JSON.parse(toolCalls[0].arguments)).toEqual({ action: "click", ref: 49 });
  });

  it("extracts {action, coords} as browser", () => {
    const text = '{"action":"click","coords":[100,200]}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
  });

  it("extracts {action:'navigate', url} as browser", () => {
    const text = '{"action":"navigate","url":"https://x.com"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("browser");
  });

  it("does NOT extract {action} without recognizable browser key", () => {
    const text = '{"action":"something","unrelated":"field"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("does not synthesize browser when browser tool isn't allowed", () => {
    const text = '{"action":"click","ref":49}';
    const { toolCalls } = extractToolCallsFromText(text, new Set(["read"]));
    expect(toolCalls).toHaveLength(0);
  });
});

describe("extractToolCallsFromText — edges + safety", () => {
  it("does not reconstruct a tool call from prose narration (heuristic removed)", () => {
    const text = "run tool write with path is /tmp/a.txt content is hello world";
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
  });

  it("extracts a JSON tool call even when preceded by prose that looks like an invocation", () => {
    const text = 'run tool bash\n{"name":"read","arguments":{"path":"a.txt"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
  });

  it("returns empty for plain prose with no JSON", () => {
    const r = extractToolCallsFromText("Hi Alex, how can I help?", TOOLS);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.remainingText).toBe("Hi Alex, how can I help?");
  });

  it("returns empty for empty/null input", () => {
    expect(extractToolCallsFromText("", TOOLS).toolCalls).toHaveLength(0);
    // @ts-expect-error testing runtime guard
    expect(extractToolCallsFromText(null, TOOLS).toolCalls).toHaveLength(0);
  });

  it("preserves prose before/after an extracted JSON", () => {
    const text = 'I\'ll click that now.\n{"action":"click","ref":7}\nThen check the page.';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(remainingText).toContain("I'll click that now.");
    expect(remainingText).toContain("Then check the page.");
    expect(remainingText).not.toContain('"action"');
  });

  it("extracts multiple tool calls from one assistant message", () => {
    const text = '{"name":"read","arguments":{"path":"a.txt"}}\n{"name":"read","arguments":{"path":"b.txt"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.every(t => t.name === "read")).toBe(true);
  });

  it("ignores malformed JSON without throwing", () => {
    const text = '{"name": "browser", "arguments": {action: "click"}}';
    expect(() => extractToolCallsFromText(text, TOOLS)).not.toThrow();
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
  });

  it("respects JSON string literals containing braces", () => {
    const text = '{"name":"write","arguments":{"path":"f.json","content":"{not a tool}"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("write");
    expect(JSON.parse(toolCalls[0].arguments).content).toBe("{not a tool}");
  });

  it("generates unique ids for each synthesized call", () => {
    const text = '{"name":"read","arguments":{"path":"a"}}\n{"name":"read","arguments":{"path":"b"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);
    expect(toolCalls[0].id).toMatch(/^call_synth_/);
  });
});

// The shapes the Claude CLI path parsed with its own regexes before it was
// routed through this extractor (anthropic-client/stream-cli/stream-parse.ts).
describe("extractToolCallsFromText — tool_calls envelope and input-key shape", () => {
  const argsOf = (text: string, tools: Set<string> = TOOLS) =>
    extractToolCallsFromText(text, tools).toolCalls.map((c) => ({ name: c.name, args: JSON.parse(c.arguments) }));

  it("promotes every offered entry of one envelope, in array order", () => {
    const text = '```json\n{"tool_calls":[{"name":"read","arguments":{"a":1}},{"name":"bash","arguments":{"b":2}},{"name":"edit"}]}\n```';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls.map((c) => c.name)).toEqual(["read", "bash", "edit"]);
    expect(JSON.parse(toolCalls[2].arguments)).toEqual({}); // missing arguments → {}
    expect(remainingText).toBe("");
  });

  it("an envelope entry naming a tool that was not offered never dispatches", () => {
    expect(argsOf('{"tool_calls":[{"name":"rm_rf","arguments":{}}]}')).toEqual([]);
    expect(argsOf('{"tool_calls":[{"arguments":{}},{"name":"read","arguments":{"p":1}}]}')).toEqual([
      { name: "read", args: { p: 1 } },
    ]);
  });

  it("an envelope with nothing offered leaves the text untouched", () => {
    const text = 'lead {"tool_calls":[{"name":"rm_rf","arguments":{}}]} tail';
    expect(extractToolCallsFromText(text, TOOLS)).toEqual({ toolCalls: [], remainingText: text });
  });

  it("a non-array tool_calls is not a call", () => {
    expect(argsOf('{"tool_calls":"not-an-array"}')).toEqual([]);
  });

  it("separate envelopes promote in source order with prose kept", () => {
    const text = 'first: {"tool_calls":[{"name":"read","arguments":{}}]} then {"tool_calls":[{"name":"bash","arguments":{"x":1}}]} done';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls.map((c) => c.name)).toEqual(["read", "bash"]);
    expect(remainingText).toBe("first:  then  done");
  });

  it("the {name, input} shape carries its input as the arguments (nested kept)", () => {
    const text = '{"name":"write","input":{"path":"x","meta":{"deep":[1,{"k":"v"}]}}}\n\nWait — let me call it properly.';
    expect(argsOf(text)).toEqual([{ name: "write", args: { path: "x", meta: { deep: [1, { k: "v" }] } } }]);
  });

  it("the {name, input} shape for an unoffered tool never dispatches", () => {
    expect(argsOf('{"name":"made_up","input":{"x":1}}')).toEqual([]);
  });

  it("JSON quoted inside a string literal is not a call", () => {
    expect(argsOf('Example: "{\\"name\\":\\"read\\",\\"input\\":{}}"')).toEqual([]);
  });
});

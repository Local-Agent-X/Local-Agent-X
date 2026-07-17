/**
 * Tests for the explicit tool-call text syntaxes (layer 1 of the
 * tool-call-from-text rescue path) plus the name-resolution and JSON
 * repair ladders. Trigger: a small local model emitted `<execute_tool>`
 * XML that the JSON/prose extractor could not see (2026-07), and the
 * broader zoo of wrapper-tag / bracket / channel-marker leak formats.
 */

import { describe, it, expect } from "vitest";
import { extractToolCallsFromText } from "./tool-call-text-extractor.js";
import { findTextToolCallRanges, scanTextToolCallSyntaxes } from "./tool-call-text-syntaxes.js";
import { repairJsonText, resolveToolName } from "./tool-call-text-repair.js";

const TOOLS = new Set(["browser", "read", "write", "bash", "web_search"]);

function single(text: string) {
  const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
  expect(toolCalls).toHaveLength(1);
  return { call: toolCalls[0], remainingText };
}

describe("XML-ish wrapper tags", () => {
  it("promotes <tool_call>{envelope}</tool_call>", () => {
    const { call, remainingText } = single('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
    expect(remainingText).toBe("");
  });

  it("promotes <function_call>{envelope}</function_call> with surrounding prose kept", () => {
    const text = 'Let me write that.\n<function_call>{"name":"write","arguments":{"path":"f.txt","content":"hi"}}</function_call>\nDone.';
    const { call, remainingText } = single(text);
    expect(call.name).toBe("write");
    expect(JSON.parse(call.arguments)).toEqual({ path: "f.txt", content: "hi" });
    expect(remainingText).toContain("Let me write that.");
    expect(remainingText).toContain("Done.");
    expect(remainingText).not.toContain("function_call");
  });

  it("promotes <function=NAME>{json}</function>", () => {
    const { call } = single('<function=web_search>{"query":"llamas"}</function>');
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "llamas" });
  });

  it("promotes <function=NAME> with <parameter=K>V</parameter> pairs", () => {
    const { call } = single("<function=web_search><parameter=query>llamas</parameter></function>");
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "llamas" });
  });

  it('promotes <function name="NAME">{json}</function>', () => {
    const { call } = single('<function name="web_search">{"query":"x"}</function>');
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "x" });
  });

  it('promotes <invoke name="NAME"> with parameter tags, JSON-typed values', () => {
    const text = '<invoke name="web_search"><parameter name="query">x</parameter><parameter name="limit">5</parameter></invoke>';
    const { call, remainingText } = single(text);
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "x", limit: 5 });
    expect(remainingText).toBe("");
  });

  it("promotes a <tool_call> wrapped in a code fence", () => {
    const { call } = single('```json\n<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>\n```');
    expect(call.name).toBe("read");
  });
});

describe("truncation guard — structural repairs never promote", () => {
  // Balanced output never needs structural completion, so a payload whose
  // braces/strings had to be CLOSED was cut mid-write. Promoting it would
  // execute a PARTIAL call — the range is recognized, the call is not made.
  it("a stream-cut payload is a recognized range, NOT a call", () => {
    const text = '<tool_call>{"name":"read","arguments":{"path":"a.tx';
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
  });

  it("skeptic repro: a truncated write never dispatches partial content", () => {
    const text = '<tool_call>{"name":"write","arguments":{"path":"config.json","content":"{\\"port\\":80';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(findTextToolCallRanges(text, TOOLS)[0].promoted).toBe(false);
  });

  it("skeptic repro: a truncated bash command never dispatches", () => {
    const text = '<tool_call>{"name":"bash","arguments":{"command":"rm -rf /tmp/build && echo done';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(findTextToolCallRanges(text, TOOLS)[0].promoted).toBe(false);
  });

  it("cosmetic repair (trailing comma) still promotes — the payload was complete", () => {
    const { call } = single('<tool_call>{"name":"read","arguments":{"path":"a.txt",}}</tool_call>');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
  });
});

describe("wrapped browser shorthand — layer-2 parity regression", () => {
  it("<tool_call>{shorthand}</tool_call> promotes browser like naked shorthand always did", () => {
    const { call, remainingText } = single('<tool_call>{"action":"click","ref":49}</tool_call>');
    expect(call.name).toBe("browser");
    expect(JSON.parse(call.arguments)).toEqual({ action: "click", ref: 49 });
    expect(remainingText).toBe("");
  });

  it("[TOOL_REQUEST]{shorthand}[END_TOOL_REQUEST] promotes browser", () => {
    const { call, remainingText } = single('[TOOL_REQUEST]{"action":"click","ref":3}[END_TOOL_REQUEST]');
    expect(call.name).toBe("browser");
    expect(JSON.parse(call.arguments)).toEqual({ action: "click", ref: 3 });
    expect(remainingText).toBe("");
  });

  it("wrapped shorthand stays dead when browser is not offered", () => {
    const r = extractToolCallsFromText('<tool_call>{"action":"click","ref":49}</tool_call>', new Set(["read"]));
    expect(r.toolCalls).toHaveLength(0);
  });
});

describe("<execute_tool> blocks", () => {
  it("promotes name-on-first-line followed by JSON args", () => {
    const { call } = single('<execute_tool>\nweb_search\n{"query":"x"}\n</execute_tool>');
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "x" });
  });

  it("promotes a JSON envelope body", () => {
    const { call } = single('<execute_tool>{"name":"web_search","arguments":{"query":"x"}}</execute_tool>');
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "x" });
  });

  it("promotes a bare name body with empty args", () => {
    const { call } = single("<execute_tool>\nweb_search\n</execute_tool>");
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({});
  });

  it("<execute_tool>None</execute_tool> is a recognized range but NOT promoted", () => {
    const text = "<execute_tool>None</execute_tool>";
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(remainingText).toBe(text); // scrubbing is delivery-sanitization's job
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(text);
  });

  it("an empty block is recognized but not promoted", () => {
    const ranges = findTextToolCallRanges("<execute_tool></execute_tool>", TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
  });
});

describe("bracket forms", () => {
  it("promotes [NAME]{json}", () => {
    const { call } = single('[read]{"path":"a.txt"}');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
  });

  it("promotes [tool:NAME]{json}", () => {
    const { call } = single('[tool:read]{"path":"a.txt"}');
    expect(call.name).toBe("read");
  });

  it("consumes an optional [/NAME] closer", () => {
    const { call, remainingText } = single('[read]{"path":"a.txt"}[/read]');
    expect(call.name).toBe("read");
    expect(remainingText).toBe("");
  });

  it("promotes [TOOL_REQUEST]{envelope}[END_TOOL_REQUEST]", () => {
    const { call, remainingText } = single('[TOOL_REQUEST]{"name":"read","arguments":{"path":"a.txt"}}[END_TOOL_REQUEST]');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
    expect(remainingText).toBe("");
  });

  it("ignores bracketed prose without a parseable payload", () => {
    const text = "[note] {see the section below} for details";
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    expect(findTextToolCallRanges(text)).toHaveLength(0);
  });
});

describe("channel-marker leak form", () => {
  it("promotes <|channel|>… to=functions.NAME <|message|>{json}", () => {
    const { call, remainingText } = single('<|channel|>commentary to=functions.browser <|message|>{"action":"click","ref":3}');
    expect(call.name).toBe("browser");
    expect(JSON.parse(call.arguments)).toEqual({ action: "click", ref: 3 });
    expect(remainingText).toBe("");
  });

  it("promotes to=NAME and consumes a trailing <|call|>", () => {
    const { call, remainingText } = single('<|channel|>commentary to=web_search <|message|>{"query":"x"}<|call|>');
    expect(call.name).toBe("web_search");
    expect(remainingText).toBe("");
  });

  it("ignores a channel leak without a recipient", () => {
    const text = '<|channel|>analysis <|message|>{"thought":"hmm"}';
    expect(findTextToolCallRanges(text)).toHaveLength(0);
  });
});

describe("name validation + fuzzy repair", () => {
  it("web-search resolves to web_search", () => {
    const { call } = single('<tool_call>{"name":"web-search","arguments":{"query":"x"}}</tool_call>');
    expect(call.name).toBe("web_search");
  });

  it("Functions.browser resolves to browser", () => {
    expect(resolveToolName("Functions.browser", TOOLS)).toBe("browser");
    const { call } = single('<tool_call>{"name":"Functions.browser","arguments":{"action":"snapshot"}}</tool_call>');
    expect(call.name).toBe("browser");
  });

  it("CamelCase resolves via snake folding", () => {
    expect(resolveToolName("WebSearch", TOOLS)).toBe("web_search");
  });

  it("a one-edit typo resolves within the distance bound", () => {
    expect(resolveToolName("web_serch", TOOLS)).toBe("web_search");
  });

  it("distance-too-far is NOT matched", () => {
    expect(resolveToolName("wb_srch", TOOLS)).toBeNull();
    const text = '<tool_call>{"name":"wb_srch","arguments":{}}</tool_call>';
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
  });

  it("an unresolvable name leaves the block in the text (range recorded, no call)", () => {
    const text = '<tool_call>{"name":"totally_unknown","arguments":{}}</tool_call>';
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(0);
    expect(remainingText).toBe(text);
  });

  it("short offered names get no fuzzy budget (30% rule)", () => {
    expect(resolveToolName("rd", TOOLS)).toBeNull(); // read: floor(4*0.3)=1, distance 2
  });
});

describe("caps", () => {
  it("an over-cap args payload is not promoted, and its inner JSON cannot sneak past layer 2", () => {
    const big = "x".repeat(270_000); // > 256K chars
    const text = `<tool_call>{"name":"read","arguments":{"path":"${big}"}}</tool_call>`;
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
  });

  it("an over-cap tool name is not promoted", () => {
    const longName = "a".repeat(130);
    expect(resolveToolName(longName, new Set([longName]))).toBeNull();
  });
});

describe("layer interplay", () => {
  it("extracts mixed syntaxes in source order", () => {
    const text = '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>\n[write]{"path":"b.txt","content":"y"}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls.map((t) => t.name)).toEqual(["read", "write"]);
  });

  it("marked syntax coexists with a naked JSON envelope in the same turn", () => {
    const text = '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>\n{"name":"read","arguments":{"path":"b.txt"}}';
    const { toolCalls } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls).toHaveLength(2);
    expect(JSON.parse(toolCalls[1].arguments).path).toBe("b.txt");
  });

  it("scan returns exact non-overlapping ranges", () => {
    const text = 'pre <tool_call>{"name":"read","arguments":{}}</tool_call> post';
    const hits = scanTextToolCallSyntaxes(text);
    expect(hits).toHaveLength(1);
    expect(text.slice(hits[0].start, hits[0].end)).toBe('<tool_call>{"name":"read","arguments":{}}</tool_call>');
  });

  it("findTextToolCallRanges without a tool set gives the syntax-only verdict", () => {
    const text = '<tool_call>{"name":"anything","arguments":{}}</tool_call>';
    expect(findTextToolCallRanges(text)[0].promoted).toBe(true);
    expect(findTextToolCallRanges(text, TOOLS)[0].promoted).toBe(false);
  });
});

describe("repairJsonText ladder + repair classes", () => {
  it("passes valid JSON through unchanged as kind none", () => {
    expect(repairJsonText('{"a":1}')).toEqual({ text: '{"a":1}', kind: "none" });
  });

  it("strips trailing commas as a COSMETIC repair", () => {
    const r = repairJsonText('{"a": 1, "b": [1, 2,],}')!;
    expect(r.kind).toBe("cosmetic");
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: [1, 2] });
  });

  it("escapes raw control characters as a COSMETIC repair", () => {
    const r = repairJsonText('{"cmd": "line1\nline2\ttab"}')!;
    expect(r.kind).toBe("cosmetic");
    expect(JSON.parse(r.text)).toEqual({ cmd: "line1\nline2\ttab" });
  });

  it("classifies closing truncated braces/brackets as STRUCTURAL", () => {
    const r = repairJsonText('{"a": {"b": [1, 2')!;
    expect(r.kind).toBe("structural");
    expect(JSON.parse(r.text)).toEqual({ a: { b: [1, 2] } });
  });

  it("classifies closing a truncated string value as STRUCTURAL", () => {
    const r = repairJsonText('{"path": "a.tx')!;
    expect(r.kind).toBe("structural");
    expect(JSON.parse(r.text)).toEqual({ path: "a.tx" });
  });

  it("classifies a dangling comma at a truncation point as STRUCTURAL", () => {
    const r = repairJsonText('{"a": 1,')!;
    expect(r.kind).toBe("structural");
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });

  it("does not invent quotes for bare keys", () => {
    expect(repairJsonText('{action: "click"}')).toBeNull();
  });

  it("gives up on runaway nesting (bounded)", () => {
    expect(repairJsonText("[".repeat(60))).toBeNull();
  });
});

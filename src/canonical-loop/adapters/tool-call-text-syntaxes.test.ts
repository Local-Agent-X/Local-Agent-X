/**
 * Tests for the explicit tool-call text syntaxes (layer 1 of the
 * tool-call-from-text rescue path) plus the name-resolution and JSON
 * repair ladders. Trigger: a small local model emitted `<execute_tool>`
 * XML that the JSON/prose extractor could not see (2026-07), and the
 * broader zoo of wrapper-tag / bracket / channel-marker leak formats.
 */

import { performance } from "node:perf_hooks";
import { describe, it, expect } from "vitest";
import { extractToolCallsFromText } from "./tool-call-text-extractor.js";
import { findTextToolCallRanges, maskCodeSpans, scanTextToolCallSyntaxes } from "./tool-call-text-syntaxes.js";
import { MAX_ARGS_CHARS, repairJsonText, resolveToolName, scanBalancedObject } from "./tool-call-text-repair.js";

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

describe("namespaced tags — incident 2026-09-08 (muse-glimmer:30b)", () => {
  // Verbatim leak: a garbled Anthropic-internal namespace on every tag.
  // Every recognizer in the repo anchored the bare tag name and missed it.
  const INCIDENT = [
    "<atem:function_calls>",
    '<atem:invoke name="grep">',
    '<atem:parameter name="pattern">footer</atem:parameter>',
    '<atem:parameter name="path">workspace/apps/bellavida-medical-massage-clone</atem:parameter>',
    '<atem:parameter name="output_mode">content</atem:parameter>',
    "</atem:invoke>",
    "</atem:function_calls>",
  ].join("\n");
  const GREP_TOOLS = new Set([...TOOLS, "grep"]);

  it("yields ONE candidate whose range covers the whole block, wrapper included", () => {
    const hits = scanTextToolCallSyntaxes(INCIDENT);
    expect(hits).toHaveLength(1);
    expect(hits[0].candidate?.name).toBe("grep");
    expect(JSON.parse(hits[0].candidate!.argsJson)).toEqual({
      pattern: "footer",
      path: "workspace/apps/bellavida-medical-massage-clone",
      output_mode: "content",
    });
    expect(INCIDENT.slice(hits[0].start, hits[0].end)).toBe(INCIDENT);
  });

  it("promotes through the extractor and leaves nothing of the wrapper behind", () => {
    const { toolCalls, remainingText } = extractToolCallsFromText(`Searching.\n${INCIDENT}\n`, GREP_TOOLS);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("grep");
    expect(remainingText).toBe("Searching.");
  });

  it("namespaced <tool_call>{envelope}</tool_call>", () => {
    const { call, remainingText } = single('<x:tool_call>{"name":"read","arguments":{"path":"a.txt"}}</x:tool_call>');
    expect(call.name).toBe("read");
    expect(remainingText).toBe("");
  });

  it("namespaced <function=NAME> with namespaced <parameter> pairs", () => {
    const { call, remainingText } = single("<ns.v1:function=web_search><ns.v1:parameter=query>llamas</ns.v1:parameter></ns.v1:function>");
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "llamas" });
    expect(remainingText).toBe("");
  });

  it("namespaced <execute_tool> keeps the name-line grammar", () => {
    const { call } = single('<a:execute_tool>\nweb_search\n{"query":"x"}\n</a:execute_tool>');
    expect(call.name).toBe("web_search");
    expect(JSON.parse(call.arguments)).toEqual({ query: "x" });
  });

  it("a <function_calls> wrapper with several <invoke> children yields one candidate each, wrapper consumed once", () => {
    const text = '<function_calls>\n<invoke name="read"><parameter name="path">a</parameter></invoke>\n' +
      '<invoke name="read"><parameter name="path">b</parameter></invoke>\n</function_calls>';
    const hits = scanTextToolCallSyntaxes(text);
    expect(hits.map((h) => h.candidate?.name)).toEqual(["read", "read"]);
    expect(hits[0].start).toBe(0);
    expect(hits[1].end).toBe(text.length);
    const { toolCalls, remainingText } = extractToolCallsFromText(text, TOOLS);
    expect(toolCalls.map((t) => JSON.parse(t.arguments).path)).toEqual(["a", "b"]);
    expect(remainingText).toBe("");
  });
});

describe("<tool_use> wrapper", () => {
  it("promotes a JSON payload", () => {
    const { call, remainingText } = single('<tool_use>{"name":"read","input":{"path":"a.txt"}}</tool_use>');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
    expect(remainingText).toBe("");
  });

  it("promotes <parameter> children with the name in a `name` pair", () => {
    const text = '<tool_use>\n<parameter name="name">read</parameter>\n<parameter name="path">a.txt</parameter>\n</tool_use>';
    const { call, remainingText } = single(text);
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
    expect(remainingText).toBe("");
  });

  it("promotes <parameter> children with the name on the opener", () => {
    const { call } = single('<tool_use name="read"><parameter name="path">a.txt</parameter></tool_use>');
    expect(call.name).toBe("read");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
  });

  it("<tool_result> is recognized leak syntax but never a call", () => {
    const text = '<tool_result>{"name":"read","arguments":{"path":"a.txt"}}</tool_result>';
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(text);
  });
});

describe("fragments — recognized, never promoted", () => {
  it("an unterminated wrapper opener owns the text to the end", () => {
    const text = "Sure.\n<tool_call>\nlet me look at";
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("<tool_call>\nlet me look at");
  });

  it("a named opener cut mid-parameter runs to the end and is not a call", () => {
    const text = '<invoke name="bash"><parameter name="command">rm -rf /tmp/bui';
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(ranges[0].end).toBe(text.length);
  });

  it("a closed wrapper with a preamble before its JSON still promotes and owns the opener", () => {
    const text = '<tool_call> here it is:\n{"name":"read","arguments":{"path":"a.txt"}}</tool_call>';
    const { call, remainingText } = single(text);
    expect(call.name).toBe("read");
    expect(remainingText).toBe("");
  });

  it("a stray </parameter> is a recognized fragment", () => {
    const text = "x </parameter> y";
    const ranges = findTextToolCallRanges(text);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(["</parameter>"]);
  });

  it("an opener with a newline inside its attributes is one block, not orphan fragments", () => {
    const text = '<invoke\nname="read">\n<parameter name="path">a.txt</parameter>\n</invoke>';
    const hits = scanTextToolCallSyntaxes(text);
    expect(hits).toHaveLength(1);
    expect(text.slice(hits[0].start, hits[0].end)).toBe(text);
    expect(hits[0].candidate).toEqual({ name: "read", argsJson: '{"path":"a.txt"}' });
  });
});

describe("truncation invariant — an opener with no closer never promotes", () => {
  // Skeptic repro: generation stops after one COMPLETE parameter pair with
  // no </invoke> and no </function_calls>. The pair looks finished; the
  // call was still being written. A partial write must not execute.
  const cut: Array<[string, string]> = [
    ["namespaced wrapper + invoke", '<atem:function_calls>\n<atem:invoke name="write">\n<atem:parameter name="path">a.txt</atem:parameter>'],
    ["bare wrapper + invoke", '<function_calls>\n<invoke name="write">\n<parameter name="path">a.txt</parameter>'],
    ["bare invoke", '<invoke name="write"><parameter name="path">a.txt</parameter>\n'],
    ["function=NAME", '<function=write><parameter name="path">a.txt</parameter>'],
    ["tool_use with a name pair", '<tool_use>\n<parameter name="name">write</parameter>\n<parameter name="path">a.txt</parameter>'],
    ["tool_call with a name pair", '<tool_call>\n<parameter name="name">write</parameter>\n<parameter name="path">a.txt</parameter>'],
    ["closed invoke inside an unclosed wrapper", '<function_calls>\n<invoke name="write"><parameter name="path">a.txt</parameter></invoke>'],
    ["balanced JSON with no closer", '<tool_call>{"name":"write","arguments":{"path":"a.txt","content":"x"}}'],
    ["named tag, balanced JSON, no closer", '<invoke name="write">{"path":"a.txt","content":"x"}'],
    ["bracket wrapper with no closer", '[TOOL_REQUEST]{"name":"write","arguments":{"path":"a.txt"}}'],
  ];
  for (const [label, text] of cut) {
    it(`${label}: recognized range to end-of-text, promoted:false, extractor emits nothing`, () => {
      expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
      const ranges = findTextToolCallRanges(text, TOOLS);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual({ start: 0, end: text.length, promoted: false });
    });
  }

  it("the same pair run WITH its closers promotes — the closer is the completeness signal", () => {
    const { call } = single('<function_calls>\n<invoke name="write">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>');
    expect(call.name).toBe("write");
    expect(JSON.parse(call.arguments)).toEqual({ path: "a.txt" });
  });
});

describe("weak bracket marker — exact names only", () => {
  it("[NAME]{json} with a near-miss name does not promote (no fuzzy ladder for the weakest marker)", () => {
    for (const text of ['[Read]{"path":"a.txt"}', '[web-search]{"query":"x"}', '- [reed] {"path": "a.txt"} is the shape']) {
      expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
      const ranges = findTextToolCallRanges(text, TOOLS);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].promoted).toBe(false);
    }
  });

  it("[tool:NAME]{json} keeps fuzzy resolution", () => {
    const { call } = single('[tool:web-search]{"query":"x"}');
    expect(call.name).toBe("web_search");
  });

  it("[TOOL_REQUEST]{envelope}[END_TOOL_REQUEST] keeps fuzzy resolution", () => {
    const { call } = single('[TOOL_REQUEST]{"name":"Functions.browser","arguments":{"action":"snapshot"}}[END_TOOL_REQUEST]');
    expect(call.name).toBe("browser");
  });

  it("scan exposes the weak-marker flag on the candidate", () => {
    expect(scanTextToolCallSyntaxes('[read]{"path":"a"}')[0].candidate?.exactNameOnly).toBe(true);
    expect(scanTextToolCallSyntaxes('[tool:read]{"path":"a"}')[0].candidate?.exactNameOnly).toBeUndefined();
  });
});

describe("code-span masking", () => {
  it("maskCodeSpans keeps length and newlines, NULs code bytes", () => {
    const text = "say `<x>`\n```\nab\n```";
    const shadow = maskCodeSpans(text);
    expect(shadow.length).toBe(text.length);
    const nul = (n: number) => String.fromCharCode(0).repeat(n);
    expect(shadow).toBe(`say ${nul(5)}\n${nul(3)}\n${nul(2)}\n${nul(3)}`);
  });

  it("findTextToolCallRanges masks by default: a backticked mention is not a leak", () => {
    const text = "Wrap calls in `<function_calls>` and never emit `</invoke>` as text.";
    expect(findTextToolCallRanges(text)).toHaveLength(0);
    expect(findTextToolCallRanges(text, undefined, { maskCodeSpans: false })).not.toHaveLength(0);
  });

  it("a real block after a backticked mention is found, the prose between survives", () => {
    const pre = 'Use `<invoke name="read">` like so:\n';
    const block = '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>';
    const text = `${pre}${block}\nthen stop.`;
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual([block]);
    expect(ranges[0].promoted).toBe(true);
  });

  it("scanTextToolCallSyntaxes does not mask by default (the extractor promotes fenced payloads)", () => {
    const text = '```\n<tool_call>{"name":"read","arguments":{}}</tool_call>\n```';
    expect(scanTextToolCallSyntaxes(text)).toHaveLength(1);
    expect(scanTextToolCallSyntaxes(text, { maskCodeSpans: true })).toHaveLength(0);
  });
});

describe("pathological input stays linear", () => {
  const BUDGET_MS = 250;
  it("[a]{ × 8000 — openers whose payload never balances", () => {
    const text = "[a]{".repeat(8000);
    const t0 = performance.now();
    expect(findTextToolCallRanges(text, TOOLS)).toHaveLength(0);
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it("<tool_call> + 200KB of `{`", () => {
    const text = "<tool_call>" + "{".repeat(200_000);
    const t0 = performance.now();
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toEqual([{ start: 0, end: text.length, promoted: false }]);
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  });

  it("scanBalancedObject gives up after MAX_ARGS_CHARS and memoizes nested verdicts", () => {
    const over = "{".repeat(MAX_ARGS_CHARS + 10);
    expect(scanBalancedObject(over, 0)).toBe(-1);
    const memo = new Map<number, number>();
    const text = '{"a":{"b":1},"c":{';
    expect(scanBalancedObject(text, 0, memo)).toBe(-1);
    expect(memo.get(5)).toBe(12); // the balanced inner {"b":1}
    expect(memo.get(17)).toBe(-1); // the unbalanced trailing {
    expect(memo.get(0)).toBe(-1);
  });

  it("a lone closer loses only the tag", () => {
    const text = "All done.</tool_call> Anything else?";
    const ranges = findTextToolCallRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("</tool_call>");
  });

  it("a lone namespaced closer is recognized", () => {
    const text = "ok\n</atem:invoke>\n</atem:function_calls>";
    const ranges = findTextToolCallRanges(text);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(["</atem:invoke>", "</atem:function_calls>"]);
  });

  it("an orphan <parameter> pair is recognized", () => {
    const text = 'x <parameter name="path">a.txt</parameter> y';
    const ranges = findTextToolCallRanges(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('<parameter name="path">a.txt</parameter>');
    expect(ranges[0].promoted).toBe(false);
  });

  it("closers consumed by their block are not double-reported", () => {
    const text = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
    expect(findTextToolCallRanges(text)).toHaveLength(1);
  });
});

describe("[TOOL_CALL] bracket wrapper", () => {
  it("[TOOL_CALL]{envelope}[/TOOL_CALL] promotes", () => {
    const { call, remainingText } = single('[TOOL_CALL]{"name":"read","arguments":{"path":"a.txt"}}[/TOOL_CALL]');
    expect(call.name).toBe("read");
    expect(remainingText).toBe("");
  });

  it("[TOOL_CALL]…[/TOOL_CALL] with an unstructured body is a range, not a call", () => {
    const text = "[TOOL_CALL] read a.txt [/TOOL_CALL] then";
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
    const ranges = findTextToolCallRanges(text, TOOLS);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].promoted).toBe(false);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("[TOOL_CALL] read a.txt [/TOOL_CALL]");
  });

  it("[TOOL_CALL] with no closer runs to the end", () => {
    const text = "prose [TOOL_CALL] read a.txt";
    const ranges = findTextToolCallRanges(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("[TOOL_CALL] read a.txt");
  });
});

describe("prose about tags is not call syntax", () => {
  it("a bare <invoke> mention (no name attr, no closer) is left alone", () => {
    const text = "I typed <invoke> once and it did nothing.";
    expect(findTextToolCallRanges(text)).toHaveLength(0);
    expect(extractToolCallsFromText(text, TOOLS).toolCalls).toHaveLength(0);
  });

  it("tag names discussed in backticks are left alone", () => {
    const text = "The `<function>` tag wraps a `<parameter>` element in that dialect.";
    expect(findTextToolCallRanges(text)).toHaveLength(0);
  });

  it("<functionx> is not <function>", () => {
    expect(findTextToolCallRanges("<functionx name=\"read\">{}</functionx>")).toHaveLength(0);
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

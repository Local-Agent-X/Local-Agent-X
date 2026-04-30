import { describe, it, expect } from "vitest";
import { filterStreamDelta, stripToolCallBlocks } from "../src/anthropic-client/parse.js";

// Simulate the streaming pipeline. The shape mirrors stream-cli.ts:253-254 —
// the consumer only flips `suppress` when the result EXPLICITLY carries a
// suppress field. The close-marker branch in parse.ts returns `{ text: "" }`
// with NO suppress field, so suppress stays latched ON. That's BUG #2 in
// BUGS-FOUND.md and the assertions below capture the actual current behavior.
function runStream(deltas: string[]): { visible: string; suppressedAtEnd: boolean } {
  let suppress = false;
  const out: string[] = [];
  for (const d of deltas) {
    const r = filterStreamDelta(d, suppress);
    if (r.text !== undefined && r.text !== "") out.push(r.text);
    if (r.suppress !== undefined) suppress = r.suppress;
  }
  return { visible: out.join(""), suppressedAtEnd: suppress };
}

describe("filterStreamDelta — open-marker detection (JSON forms)", () => {
  it("``` json fence triggers suppression", () => {
    const r = filterStreamDelta("```json\n", false);
    expect(r.suppress).toBe(true);
  });

  it('inline {"tool_calls" prefix triggers suppression', () => {
    const r = filterStreamDelta('{"tool_calls":[', false);
    expect(r.suppress).toBe(true);
  });

  it("bare ``` (trimmed) triggers suppression", () => {
    const r = filterStreamDelta("```", false);
    expect(r.suppress).toBe(true);
  });

  it("bare ``` with surrounding whitespace still triggers (trim path)", () => {
    const r = filterStreamDelta("  ```  ", false);
    expect(r.suppress).toBe(true);
  });

  it("normal prose passes through untouched", () => {
    const r = filterStreamDelta("Hello there.", false);
    expect(r.suppress).toBeUndefined();
    expect(r.text).toBe("Hello there.");
  });
});

describe("filterStreamDelta — open-marker detection (XML forms)", () => {
  it("<tool_use> triggers suppression", () => {
    expect(filterStreamDelta("<tool_use>", false).suppress).toBe(true);
  });

  it("<function_calls> triggers suppression", () => {
    expect(filterStreamDelta("<function_calls>", false).suppress).toBe(true);
  });

  it("an XML tag glued to leading prose triggers suppression for the WHOLE delta — losing the prose (a known leak)", () => {
    // documents BUG #2 fallout: when a chunk arrives as "Sure, let me <tool_use>"
    // the producer has no concept of mid-chunk prose extraction. The whole chunk
    // is suppressed.
    const r = filterStreamDelta("Sure, let me <tool_use>", false);
    expect(r.suppress).toBe(true);
    expect(r.text).toBeUndefined();
  });
});

describe("filterStreamDelta — close-marker behavior (documents BUG #2)", () => {
  it("close fence ``` returns text:'' but does NOT reset suppress", () => {
    const r = filterStreamDelta("```", true);
    expect(r.text).toBe("");
    // BUG #2: ideal behavior would be { text: "", suppress: false }.
    // Current code omits suppress, leaving the consumer's flag stuck ON.
    expect(r.suppress).toBeUndefined();
  });

  it("close brace }\\n returns text:'' but does NOT reset suppress", () => {
    const r = filterStreamDelta("}\n", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBeUndefined();
  });

  it("</tool_use> returns text:'' but does NOT reset suppress", () => {
    const r = filterStreamDelta("</tool_use>", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBeUndefined();
  });

  it("</function_calls> returns text:'' but does NOT reset suppress", () => {
    const r = filterStreamDelta("</function_calls>", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBeUndefined();
  });

  it("any chunk while alreadySuppressing without a close marker stays suppressed", () => {
    const r = filterStreamDelta('"some":"json"', true);
    expect(r.suppress).toBe(true);
    expect(r.text).toBeUndefined();
  });
});

describe("filterStreamDelta — full streaming flow (documents BUG #2 — text after close is dropped)", () => {
  it("a fenced ```json call: prose before survives, prose after is silently dropped", () => {
    const { visible, suppressedAtEnd } = runStream([
      "Sure thing. ",
      "```json\n",
      '{"tool_calls":[{"name":"x","arguments":{}}]}',
      "\n```",
      " more text",
    ]);
    expect(visible).toBe("Sure thing. ");
    expect(visible).not.toContain("tool_calls");
    expect(visible).not.toContain(" more text");
    expect(suppressedAtEnd).toBe(true);
  });

  it("XML tool_use block: prose before survives, prose after is silently dropped", () => {
    const { visible, suppressedAtEnd } = runStream([
      "Reply text. ",
      "<tool_use>",
      '<parameter name="task">do the thing</parameter>',
      "</tool_use>",
      " trailing",
    ]);
    expect(visible).toBe("Reply text. ");
    expect(visible).not.toContain("<tool_use>");
    expect(visible).not.toContain(" trailing");
    expect(suppressedAtEnd).toBe(true);
  });

  it('inline {"tool_calls":...}\\n: prose before survives, prose after is silently dropped', () => {
    const { visible } = runStream([
      "let me ",
      '{"tool_calls":[{"name":"y","arguments":{}}]}',
      "\n",
      " done.",
    ]);
    expect(visible).toBe("let me ");
    expect(visible).not.toContain("tool_calls");
    expect(visible).not.toContain(" done.");
  });
});

describe("filterStreamDelta — suppression staying open across many filler chunks", () => {
  it("blocks every chunk between open and close markers", () => {
    let suppress = false;
    const trace: { delta: string; suppress: boolean | undefined; text: string | undefined }[] = [];
    const deltas = ["```json", '"name":', '"foo",', '"arguments":', "{}", "}\n"];
    for (const d of deltas) {
      const r = filterStreamDelta(d, suppress);
      trace.push({ delta: d, suppress: r.suppress, text: r.text });
      if (r.suppress !== undefined) suppress = r.suppress;
    }
    // Open chunk: suppress=true, text undefined
    expect(trace[0]).toEqual({ delta: "```json", suppress: true, text: undefined });
    // Middle chunks: stay in suppressed state, text:"" returned (no close marker hit)
    for (let i = 1; i < trace.length - 1; i++) {
      expect(trace[i].text).toBeUndefined();
      expect(trace[i].suppress).toBe(true);
    }
    // Close chunk emits text:"" but does NOT reset suppress (BUG #2)
    expect(trace[trace.length - 1].text).toBe("");
    expect(trace[trace.length - 1].suppress).toBeUndefined();
  });
});

describe("filterStreamDelta — partial-prefix detection limitations (documents behavior)", () => {
  it("'``' (one backtick short of ```) is NOT suppressed", () => {
    const r = filterStreamDelta("``", false);
    expect(r.suppress).toBeUndefined();
    expect(r.text).toBe("``");
  });

  it("'```js' (broken json prefix) is NOT suppressed — only literal ```json or bare ``` match", () => {
    const r = filterStreamDelta("```js", false);
    expect(r.suppress).toBeUndefined();
    expect(r.text).toBe("```js");
  });

  it("'```javascript' (a different language fence) is NOT suppressed", () => {
    const r = filterStreamDelta("```javascript", false);
    expect(r.suppress).toBeUndefined();
    expect(r.text).toBe("```javascript");
  });
});

describe("stripToolCallBlocks — post-hoc cleanup", () => {
  it("removes inline {\"tool_calls\":...} JSON from a flat string", () => {
    const leak = 'pre {"tool_calls":[{"name":"x","arguments":{}}]} post';
    const cleaned = stripToolCallBlocks(leak);
    expect(cleaned).not.toContain("tool_calls");
    expect(cleaned).toContain("pre");
    expect(cleaned).toContain("post");
  });

  it("removes ```json fenced tool-call block", () => {
    const leak = 'before\n```json\n{"tool_calls":[{"name":"x","arguments":{}}]}\n```\nafter';
    const cleaned = stripToolCallBlocks(leak);
    expect(cleaned).not.toContain("tool_calls");
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
  });

  it("removes <tool_use> XML block", () => {
    const leak = 'before <tool_use><parameter name="x">v</parameter></tool_use> after';
    const cleaned = stripToolCallBlocks(leak);
    expect(cleaned).not.toContain("<tool_use>");
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
  });

  it("removes <function_calls> XML block", () => {
    const leak = 'before <function_calls><invoke name="x"></invoke></function_calls> after';
    const cleaned = stripToolCallBlocks(leak);
    expect(cleaned).not.toContain("function_calls");
    expect(cleaned).toContain("before");
    expect(cleaned).toContain("after");
  });

  it("leaves clean text untouched", () => {
    const clean = "just normal prose with no tool calls anywhere";
    expect(stripToolCallBlocks(clean)).toBe(clean);
  });
});

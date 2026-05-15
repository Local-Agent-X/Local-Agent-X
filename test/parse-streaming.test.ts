import { describe, it, expect } from "vitest";
import { filterStreamDelta, stripToolCallBlocks } from "../src/anthropic-client/parse.js";

// Simulate the streaming pipeline. The shape mirrors stream-cli.ts:253-254 —
// the consumer only flips `suppress` when the result EXPLICITLY carries a
// suppress field. The close-marker branch in parse.ts now returns
// `{ text: "", suppress: false }` so the consumer's flag resets and prose
// after the tool block survives.
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

describe("filterStreamDelta — close-marker behavior resets suppression", () => {
  it("close fence ``` returns text:'' and resets suppress to false", () => {
    const r = filterStreamDelta("```", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBe(false);
  });

  it("close brace }\\n returns text:'' and resets suppress to false", () => {
    const r = filterStreamDelta("}\n", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBe(false);
  });

  it("</tool_use> returns text:'' and resets suppress to false", () => {
    const r = filterStreamDelta("</tool_use>", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBe(false);
  });

  it("</function_calls> returns text:'' and resets suppress to false", () => {
    const r = filterStreamDelta("</function_calls>", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBe(false);
  });

  it("any chunk while alreadySuppressing without a close marker stays suppressed", () => {
    const r = filterStreamDelta('"some":"json"', true);
    expect(r.suppress).toBe(true);
    expect(r.text).toBeUndefined();
  });
});

describe("filterStreamDelta — full streaming flow (prose after close resumes)", () => {
  it("a fenced ```json call: prose before and after survive, tool call is stripped", () => {
    const { visible, suppressedAtEnd } = runStream([
      "Sure thing. ",
      "```json\n",
      '{"tool_calls":[{"name":"x","arguments":{}}]}',
      "\n```",
      " more text",
    ]);
    expect(visible).toContain("Sure thing. ");
    expect(visible).toContain(" more text");
    expect(visible).not.toContain("tool_calls");
    expect(suppressedAtEnd).toBe(false);
  });

  it("XML tool_use block: prose before and after survive, tool block is stripped", () => {
    const { visible, suppressedAtEnd } = runStream([
      "Reply text. ",
      "<tool_use>",
      '<parameter name="task">do the thing</parameter>',
      "</tool_use>",
      " trailing",
    ]);
    expect(visible).toContain("Reply text. ");
    expect(visible).toContain(" trailing");
    expect(visible).not.toContain("<tool_use>");
    expect(suppressedAtEnd).toBe(false);
  });

  it('inline {"tool_calls":...} streamed across deltas: prose before and after both survive', () => {
    // Realistic streaming — the open marker is in its own delta, body chunks
    // follow, and the close "}\n" arrives in a later delta. This is how the
    // streamer actually emits inline JSON tool calls.
    const { visible } = runStream([
      "let me ",
      '{"tool_calls":[',
      '{"name":"y","arguments":{}}',
      "]}\n",
      " done.",
    ]);
    expect(visible).toContain("let me ");
    expect(visible).toContain(" done.");
    expect(visible).not.toContain("tool_calls");
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
    // Close chunk emits text:"" and resets suppress to false
    expect(trace[trace.length - 1].text).toBe("");
    expect(trace[trace.length - 1].suppress).toBe(false);
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

describe("filterStreamDelta — self-contained chunk (open + close in one delta)", () => {
  it("a single delta containing the entire fenced JSON block latches suppress (close marker is also detected at start)", () => {
    // Real producer rarely emits the whole block as one chunk, but if it
    // does, the open-marker check fires FIRST (alreadySuppressing is false).
    // Suppress is set to true; nothing after this delta survives until a
    // subsequent close marker — but here close-marker is in the SAME chunk
    // so it never gets a chance to reset (BUG #2 doubles down).
    const r = filterStreamDelta('```json\n{"tool_calls":[]}\n```', false);
    expect(r.suppress).toBe(true);
    // No text emitted; the whole chunk is suppressed
    expect(r.text).toBeUndefined();
  });

  it("a single delta with self-contained <tool_use>...</tool_use> stays in suppressed state", () => {
    const r = filterStreamDelta('<tool_use><parameter name="x">v</parameter></tool_use>', false);
    expect(r.suppress).toBe(true);
    expect(r.text).toBeUndefined();
  });

  it("a chunk arriving while suppressing that ALSO contains an open marker hits close-marker branch first", () => {
    // alreadySuppressing=true → close-marker check runs first. If the chunk
    // contains '```' (which any open marker like ```json also contains), it
    // matches the close branch and emits {text:"", suppress:false}.
    // Documents the string-match-not-state-machine semantics — back-to-back
    // tool calls re-arm suppression on their inner content marker.
    const r = filterStreamDelta("```json", true);
    expect(r.text).toBe("");
    expect(r.suppress).toBe(false);
  });
});

describe("stripToolCallBlocks — non-greedy + nested-resilient", () => {
  it("strips two consecutive ```json blocks without merging the gap into the cleanup", () => {
    const input =
      'A ```json\n{"tool_calls":[{"name":"a","arguments":{}}]}\n``` B ' +
      '```json\n{"tool_calls":[{"name":"b","arguments":{}}]}\n``` C';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("C");
  });

  it("strips two consecutive <tool_use> blocks without swallowing the prose between", () => {
    const input =
      'one <tool_use><parameter name="x">v1</parameter></tool_use> two ' +
      '<tool_use><parameter name="y">v2</parameter></tool_use> three';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("<tool_use>");
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("three");
  });

  it("leaves an unclosed <tool_use> tag alone (regex requires closing tag)", () => {
    // If the closing tag is missing, the .*? non-greedy match has nothing
    // to terminate on and the regex doesn't match. The unclosed tag stays.
    const input = "lead <tool_use><parameter name=\"x\">v</parameter> trailing";
    const out = stripToolCallBlocks(input);
    expect(out).toContain("<tool_use>");
  });

  it("falls back to raw JSON regex when fenced block is missing its closing ```", () => {
    // The fenced regex requires a closing ```, so an unclosed block fails
    // that pattern. But the standalone {"tool_calls":...} regex DOES match
    // the inner JSON, so the call is still stripped — defense in depth.
    const input = 'lead\n```json\n{"tool_calls":[{"name":"x","arguments":{}}]}\n trailing';
    const out = stripToolCallBlocks(input);
    expect(out).not.toContain("tool_calls");
    expect(out).toContain("lead");
    expect(out).toContain("trailing");
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

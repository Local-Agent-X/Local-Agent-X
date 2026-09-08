import { describe, expect, it } from "vitest";
import { filterStreamDelta, sanitizeAssistantTextForRebuild, stripToolCallBlocks } from "./parse.js";

/** 2026-09-08 muse-glimmer incident: a namespaced Anthropic-internal block
 *  leaked as plain text and no bare-tag regex matched it. */
const INCIDENT =
  `<atem:function_calls>\n<atem:invoke name="grep">\n<atem:parameter name="pattern">footer</atem:parameter>\n` +
  `<atem:parameter name="path">workspace/apps/bellavida-medical-massage-clone</atem:parameter>\n` +
  `<atem:parameter name="output_mode">content</atem:parameter>\n</atem:invoke>\n</atem:function_calls>`;

const TOOL_USE = `<tool_use>\n<parameter name="name">read_file</parameter>\n<parameter name="path">a.ts</parameter>\n</tool_use>`;
const FCALLS = `<function_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>`;
const FENCED = '```json\n{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}\n```';

describe("stripToolCallBlocks", () => {
  it("removes the namespaced incident block entirely — no dangling closer", () => {
    const out = stripToolCallBlocks(`Searching now.\n${INCIDENT}\nDone.`);
    expect(out).toBe("Searching now.\n\nDone.");
    expect(out).not.toMatch(/atem|function_calls|invoke|parameter/);
  });

  it("still strips the bare <tool_use> and <function_calls> shapes", () => {
    expect(stripToolCallBlocks(`before ${TOOL_USE} after`)).toBe("before  after");
    expect(stripToolCallBlocks(`before ${FCALLS} after`)).toBe("before  after");
  });

  it("still strips an orphan <parameter> pair and a lone closer", () => {
    expect(stripToolCallBlocks(`x <parameter name="path">a.ts</parameter> y`)).toBe("x  y");
    expect(stripToolCallBlocks("x </tool_use> y")).toBe("x  y");
  });

  it("leaves the fenced JSON envelope path unchanged", () => {
    expect(stripToolCallBlocks(`hi\n${FENCED}\nbye`)).toBe("hi\n\nbye");
    expect(stripToolCallBlocks('a {"tool_calls": [{"name":"x"}]} b')).toBe("a  b");
  });

  it("still strips the bare Anthropic native shape only with a tool set", () => {
    const text = 'ok {"name":"bash","input":{"command":"ls"}} end';
    expect(stripToolCallBlocks(text)).toBe(text);
    expect(stripToolCallBlocks(text, new Set(["bash"]))).toBe("ok  end");
  });

  it("does not touch prose that mentions tags in backticks — code spans are masked", () => {
    const text = "Use the `<invoke>` tag inside `<function_calls>` blocks.";
    expect(stripToolCallBlocks("Wrap calls in `<invoke>` tags.")).toBe("Wrap calls in `<invoke>` tags.");
    expect(stripToolCallBlocks(text)).toBe(text);
  });

  it("removes a real block after a backticked mention and keeps the prose between", () => {
    const text = `Use \`<invoke name="read">\` like so:\n${FCALLS}\nthen stop.`;
    expect(stripToolCallBlocks(text)).toBe('Use `<invoke name="read">` like so:\n\nthen stop.');
  });
});

describe("sanitizeAssistantTextForRebuild", () => {
  it("replaces the incident block with a marker naming grep and reports one leak", () => {
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(`Searching now.\n${INCIDENT}\nDone.`);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ shape: "xml-tool-call", toolName: "grep" });
    expect(leaks[0].preview.startsWith("<atem:function_calls>")).toBe(true);
    expect(cleaned).toBe(
      "Searching now.\n<wire-format-error: prior attempt to call grep emitted as text — not delivered. retry using proper tool_use.>\nDone.",
    );
  });

  it("still detects the <tool_use> shape, naming the tool from its name parameter", () => {
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(`a\n${TOOL_USE}\nb`);
    expect(leaks).toEqual([expect.objectContaining({ shape: "xml-tool-call", toolName: "read_file" })]);
    expect(cleaned).toContain("prior attempt to call read_file");
    expect(cleaned).not.toContain("<tool_use>");
  });

  it("flags a <tool_use> whose name rides in a <tool_name> child, without a tool name", () => {
    // The shared recognizer's vocabulary has no <tool_name> tag, so the block
    // is scrubbed but the name is not recovered. Pinned so a vocabulary
    // change upstream shows up here as an improvement, not a surprise.
    const text = `<tool_use>\n<tool_name>read_file</tool_name>\n<parameter name="path">a.ts</parameter>\n</tool_use>`;
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text);
    expect(leaks).toEqual([expect.objectContaining({ shape: "xml-tool-call", toolName: null })]);
    expect(cleaned).not.toContain("<tool_use>");
  });

  it("still detects the <function_calls><invoke> shape", () => {
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(`a\n${FCALLS}\nb`);
    expect(leaks).toEqual([expect.objectContaining({ shape: "xml-tool-call", toolName: "bash" })]);
    expect(cleaned).toContain("prior attempt to call bash");
  });

  it("reports a null toolName for recognized syntax with no usable call inside", () => {
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild("a </tool_use> b");
    expect(leaks).toEqual([{ shape: "xml-tool-call", toolName: null, preview: "</tool_use>" }]);
    expect(cleaned).toContain("narrated tool-call intent");
  });

  it("does not flag prose mentioning `<invoke>` in backticks", () => {
    const text = "Wrap calls in `<invoke>` tags, not prose.";
    expect(sanitizeAssistantTextForRebuild(text)).toEqual({ cleaned: text, leaks: [] });
  });

  it("keeps a backticked `<function_calls>` mention intact in the rebuilt history entry", () => {
    const text = "Never emit `<function_calls>` as text; use `<invoke name=\"read\">` blocks properly.";
    expect(sanitizeAssistantTextForRebuild(text)).toEqual({ cleaned: text, leaks: [] });
  });

  it("flags a real block after a backticked mention and keeps the prose between", () => {
    const text = `Use \`<invoke name="read">\` like so:\n${FCALLS}\nthen stop.`;
    const { cleaned, leaks } = sanitizeAssistantTextForRebuild(text);
    expect(leaks).toEqual([expect.objectContaining({ shape: "xml-tool-call", toolName: "bash" })]);
    expect(cleaned).toBe(
      'Use `<invoke name="read">` like so:\n<wire-format-error: prior attempt to call bash emitted as text — not delivered. retry using proper tool_use.>\nthen stop.',
    );
  });

  it("keeps the JSON envelope shapes on their own path", () => {
    const { leaks } = sanitizeAssistantTextForRebuild(`x\n${FENCED}\ny`);
    expect(leaks).toEqual([expect.objectContaining({ shape: "openai-envelope-fenced", toolName: "bash" })]);
  });
});

describe("filterStreamDelta", () => {
  it("latches on a namespaced wrapper opener (<atem:function_calls>)", () => {
    expect(filterStreamDelta('<atem:function_calls>\n<atem:invoke name="grep">', false)).toEqual({ suppress: true });
  });

  it("unlatches on a namespaced wrapper closer (</atem:function_calls>)", () => {
    expect(filterStreamDelta("</atem:function_calls>", true)).toEqual({ text: "", suppress: false });
  });

  it("still latches on the plain <tool_use> opener", () => {
    expect(filterStreamDelta("<tool_use>", false)).toEqual({ suppress: true });
  });

  it("still unlatches on the plain </function_calls> closer", () => {
    expect(filterStreamDelta("</function_calls>", true)).toEqual({ text: "", suppress: false });
  });

  it("passes plain prose through without latching", () => {
    expect(filterStreamDelta("Here is the file you asked for.", false)).toEqual({ text: "Here is the file you asked for." });
  });

  it("keeps suppressing while latched when no closer arrives", () => {
    expect(filterStreamDelta('<parameter name="path">a.ts</parameter>', true)).toEqual({ suppress: true });
  });

  it("is stateless across calls: a second prose delta after a latch check still passes", () => {
    filterStreamDelta("<tool_use>", false);
    expect(filterStreamDelta("plain", false)).toEqual({ text: "plain" });
  });

  it("KNOWN LIMITATION: `<tool_use>` quoted inside backticks still latches (stateless per delta, not fixed)", () => {
    expect(filterStreamDelta("Never emit `<tool_use>` as text.", false)).toEqual({ suppress: true });
  });
});

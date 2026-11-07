/**
 * A tool loaded mid-chat on a local model is shown in its tool_search result,
 * not added to the tool list, so the request after the load extends the one
 * before it byte for byte and a hybrid model keeps its cache.
 */
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { inlineToolLoads, inlinesToolLoads } from "./local-tool-loads.js";
import { formatToolSearchResult, toolSearchResultNames } from "../../../tools/tool-search-result.js";

const tool = (name: string) => ({
  name,
  description: `${name} does a thing.`,
  parameters: { type: "object", properties: { limit: { type: "integer" } } },
});
const BASH = tool("bash");
const GMAIL = tool("gmail_read");

const before: ChatCompletionMessageParam[] = [
  { role: "user", content: "read my latest email" },
];
const searchCall: ChatCompletionMessageParam = {
  role: "assistant", content: "",
  tool_calls: [{ id: "s1", type: "function", function: { name: "tool_search", arguments: '{"query":"gmail_read"}' } }],
};
const searchResult: ChatCompletionMessageParam = {
  role: "tool", tool_call_id: "s1", content: formatToolSearchResult([{ name: "gmail_read", description: GMAIL.description }]),
};
const after = [...before, searchCall, searchResult];

describe("inlineToolLoads", () => {
  it("the request after a load extends the one before it: same tools, same earlier rows", () => {
    const first = inlineToolLoads(before, [BASH]);
    // The op now holds gmail_read (tool-augmentation.ts), so the request carries it.
    const next = inlineToolLoads(after, [BASH, GMAIL]);
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
  });

  it("shows the loaded tool's definition in its result, still readable as a result", () => {
    const content = inlineToolLoads(after, [BASH, GMAIL]).messages[2].content as string;
    expect(JSON.parse(content)).toEqual([{ name: "gmail_read", description: GMAIL.description, parameters: GMAIL.parameters }]);
    expect(toolSearchResultNames(content)).toEqual(["gmail_read"]);
  });

  it("renders the same bytes every request while the op holds the tool, and mutates nothing", () => {
    const input = JSON.stringify(after);
    const a = inlineToolLoads(after, [BASH, GMAIL]);
    const b = inlineToolLoads([...after, { role: "user", content: "and the one before" }], [BASH, GMAIL]);
    expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
    expect(JSON.stringify(after)).toBe(input);
  });

  it("leaves a result alone when the request does not carry what it named (a denied load)", () => {
    const out = inlineToolLoads(after, [BASH]);
    expect(out.messages[2]).toBe(searchResult);
    expect(out.tools).toEqual([BASH]);
  });

  it("leaves another tool's result naming a tool alone", () => {
    const other: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "b1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "b1", content: formatToolSearchResult([{ name: "gmail_read", description: "x" }]) },
    ];
    expect(inlineToolLoads(other, [BASH, GMAIL]).tools).toEqual([BASH, GMAIL]);
  });
});

describe("inlinesToolLoads", () => {
  it("only on Ollama's native wire, for a parser that keeps a call to a tool outside the list", () => {
    expect(inlinesToolLoads(true, { toolParser: "qwen3.5" })).toBe(true);
    // Ollama's generic parser drops a call whose name is not in `tools`.
    expect(inlinesToolLoads(true, {})).toBe(false);
    expect(inlinesToolLoads(true, null)).toBe(false);
    // LM Studio, vLLM and other OpenAI-compatible servers: their parsers are unverified.
    expect(inlinesToolLoads(false, { toolParser: "qwen3.5" })).toBe(false);
  });
});

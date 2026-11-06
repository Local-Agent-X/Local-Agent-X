/**
 * On the ChatGPT wire a tool tool_search loads rides inline in the search's
 * output, so `tools` — the front of the prompt — never changes when one loads.
 */
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { convertMessagesToInput } from "../codex-message-convert.js";
import { formatToolSearchResult } from "../tools/tool-search-result.js";
import { supportsClientToolSearch, withClientToolSearch } from "./client-tool-search.js";
import { buildRequestBody } from "./request.js";
import { createCodexStreamState, processCodexEvent } from "./stream-parse.js";
import type { CodexStreamEvent, CodexTool } from "./types.js";

const schema = { type: "object", properties: { query: { type: "string" } } };
const fn = (name: string): CodexTool => ({ type: "function", name, description: `${name} does a thing.`, parameters: schema });
const search = fn("tool_search");
const read = fn("read");
const gmail = fn("gmail_read");
const MODEL = "gpt-5.6-sol";

const before: ChatCompletionMessageParam[] = [
  { role: "user", content: "read my latest email" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1|tsc_1", type: "function", function: { name: "tool_search", arguments: "{\"query\":\"gmail_read\"}" } }] } as ChatCompletionMessageParam,
];
const after = [...before, { role: "tool", tool_call_id: "call_1|tsc_1", content: formatToolSearchResult([gmail]) } as ChatCompletionMessageParam];

const body = (history: ChatCompletionMessageParam[], tools: CodexTool[]) =>
  buildRequestBody({ model: MODEL, systemPrompt: "s", messages: history, tools });

describe("tool_search on the ChatGPT wire", () => {
  it("goes out as the client-run tool search, and its call and result replay in that form", () => {
    const b = body(after, [search, read, gmail]);
    expect((b.tools as Array<{ type: string }>)[0]).toMatchObject({ type: "tool_search", execution: "client" });
    const input = b.input as Array<Record<string, unknown>>;
    expect(input[1]).toMatchObject({ type: "tool_search_call", execution: "client", call_id: "call_1", id: "tsc_1", arguments: { query: "gmail_read" } });
    expect(input[2]).toMatchObject({ type: "tool_search_output", call_id: "call_1", tools: [{ name: "gmail_read", defer_loading: true }] });
  });

  it("never changes `tools` when a search loads one: the load rides in the output", () => {
    const first = body(before, [search, read]);
    const second = body(after, [search, read, gmail]);
    expect(second.tools).toEqual(first.tools);
    expect((second.input as unknown[]).slice(0, (first.input as unknown[]).length - 1)).toEqual((first.input as unknown[]).slice(0, -1));
  });

  it("loads nothing a result names that this request does not carry", () => {
    const denied = [...before, { role: "tool", tool_call_id: "call_1|tsc_1", content: formatToolSearchResult([fn("mission_schedule_delete")]) } as ChatCompletionMessageParam];
    const input = body(denied, [search, read]).input as Array<Record<string, unknown>>;
    expect(input[2]).toMatchObject({ type: "tool_search_output", tools: [] });
  });

  it("is unchanged without tool_search or on a model without tool search", () => {
    const items = convertMessagesToInput(after);
    expect(withClientToolSearch(MODEL, items, [read]).input).toEqual(items);
    expect(withClientToolSearch("gpt-5.2", items, [search, read]).tools).toEqual([search, read]);
    expect(supportsClientToolSearch("gpt-5.4")).toBe(true);
    expect(supportsClientToolSearch("gpt-6.1-sol")).toBe(true);
    expect(supportsClientToolSearch("gpt-5.2")).toBe(false);
  });

  it("reads the model's tool_search call off the stream as LAX's tool_search, once", async () => {
    const state = createCodexStreamState();
    const item = { type: "tool_search_call", id: "tsc_9", call_id: "call_9", execution: "client", arguments: { query: "weather" }, status: "completed" };
    const events: CodexStreamEvent[] = [
      { type: "response.output_item.done", item } as unknown as CodexStreamEvent,
      { type: "response.completed", response: { status: "completed", output: [item] } } as unknown as CodexStreamEvent,
    ];
    const calls: unknown[] = [];
    for (const e of events) for await (const y of processCodexEvent(e, state, MODEL)) if (y.type === "tool_call") calls.push(y);
    expect(calls).toEqual([{ type: "tool_call", id: "call_9|tsc_9", name: "tool_search", arguments: "{\"query\":\"weather\"}" }]);
  });
});

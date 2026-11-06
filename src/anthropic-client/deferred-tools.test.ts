/**
 * A tool tool_search loads must not change the front of the prompt: on Claude
 * it goes deferred and loads inline from a tool_reference, so the request after
 * a load starts with the same bytes as the request before it.
 */
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { convertMessages } from "./request.js";
import { deferSearchLoads, supportsDeferredTools } from "./deferred-tools.js";
import { toAnthropicTools } from "../providers/shared/tool-shape.js";
import { formatToolSearchResult } from "../tools/tool-search-result.js";

const schema = { type: "object", properties: {} };
const def = (name: string) => ({ name, description: `${name} does a thing.`, parameters: schema });
const search = def("tool_search");
const read = def("read");
const gmail = def("gmail_read");

const searchCall = (id: string, query: string): ChatCompletionMessageParam =>
  ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "tool_search", arguments: JSON.stringify({ query }) } }] } as ChatCompletionMessageParam);
const toolRow = (id: string, content: string): ChatCompletionMessageParam => ({ role: "tool", tool_call_id: id, content });

const MODEL = "claude-opus-5-5";

const anchor = def("zz_anchor");

/** The request body's tools + messages for one step, the way stream-api.ts builds them. */
function request(history: ChatCompletionMessageParam[], tools: ReturnType<typeof def>[]) {
  const view = deferSearchLoads(MODEL, convertMessages(history), tools, undefined, () => anchor);
  return { messages: view.messages, tools: toAnthropicTools(view.tools ?? [], { cacheControlLast: true, deferred: view.deferred }) };
}

describe("a tool loaded by tool_search on Claude", () => {
  const before: ChatCompletionMessageParam[] = [{ role: "user", content: "read my latest email" }, searchCall("s1", "gmail_read")];
  const after = [...before, toolRow("s1", formatToolSearchResult([gmail]))];

  it("loads inline: the result becomes a reference and the tool is sent deferred", () => {
    const req = request(after, [search, read, gmail]);
    const result = req.messages[2].content as Array<{ type: string; content: unknown }>;
    expect(result[0].content).toEqual([{ type: "tool_reference", tool_name: "gmail_read" }]);
    const sent = req.tools.find((t) => t.name === "gmail_read")!;
    expect(sent.defer_loading).toBe(true);
    expect(sent.cache_control).toBeUndefined();
  });

  it("leaves the cached prefix byte-identical to the request before the load", () => {
    const first = request(before, [search, read]);
    const second = request(after, [search, read, gmail]);
    // Tools in the prompt (everything not deferred) are unchanged, breakpoint included…
    const inPrompt = (r: typeof first) => r.tools.filter((t) => !t.defer_loading);
    expect(inPrompt(second)).toEqual(inPrompt(first));
    expect(first.tools.some((t) => t.defer_loading)).toBe(true); // deferred loading on before the load
    // …and so is every message the first request sent.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  });

  it("stays deferred on later turns, when the tool has joined the session's set", () => {
    const later = [...after, { role: "assistant", content: "done" }, { role: "user", content: "and the next one" }] as ChatCompletionMessageParam[];
    const req = request(later, [search, read, gmail]);
    expect(req.tools.find((t) => t.name === "gmail_read")!.defer_loading).toBe(true);
  });

  it("carries a deferred tool from the first request, so the first load is not the mode switch", () => {
    // Measured: the first deferred tool in a conversation misses the whole cache;
    // after that, which ones are present never does.
    const req = request(before, [search, read]);
    expect(req.tools.filter((t) => t.defer_loading).map((t) => t.name)).toEqual(["zz_anchor"]);
    expect(req.tools.filter((t) => !t.defer_loading).map((t) => t.name)).toEqual(["tool_search", "read"]);
  });

  it("leaves a result as text when it loaded nothing this request carries", () => {
    const denied = [...before, toolRow("s1", formatToolSearchResult([def("mission_schedule_delete")]))];
    const req = request(denied, [search, read]);
    expect(typeof (req.messages[2].content as Array<{ content: unknown }>)[0].content).toBe("string");
    expect(req.tools.filter((t) => t.defer_loading).map((t) => t.name)).toEqual(["zz_anchor"]);
    const nothing = [...before, toolRow("s1", "No tools matched the query.")];
    expect((request(nothing, [search, read]).messages[2].content as Array<{ content: unknown }>)[0].content).toBe("No tools matched the query.");
  });

  it("names the tool as the wire does on the subscription route", () => {
    const view = deferSearchLoads(MODEL, convertMessages(after), [search, gmail], (n) => `wire_${n}`, () => undefined);
    expect((view.messages[2].content as Array<{ content: unknown }>)[0].content).toEqual([{ type: "tool_reference", tool_name: "wire_gmail_read" }]);
  });

  it("is off on a model without deferred loading", () => {
    expect(supportsDeferredTools("claude-opus-4-1")).toBe(false);
    expect(supportsDeferredTools("claude-haiku-4-5")).toBe(true);
    expect(supportsDeferredTools("claude-sonnet-5-5")).toBe(true);
    const view = deferSearchLoads("claude-opus-4-1", convertMessages(after), [search, read, gmail], undefined, () => anchor);
    expect(view.deferred.size).toBe(0);
    expect(view.tools).toEqual([search, read, gmail]);
  });
});

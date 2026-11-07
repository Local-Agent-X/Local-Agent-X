/**
 * A tool the model loads with tool_search must not change the front of a local
 * model's prompt. Ollama renders the request's tool list into the system
 * prompt, ahead of the whole conversation, so adding a loaded tool to `tools`
 * rewrote the first bytes of the next request. A hybrid model (qwen3.6, qwen3.8)
 * resumes only from checkpoints near the end of the last prompt (local-wire.ts),
 * so that request re-read the system prompt and the whole conversation from
 * token zero, once per load.
 *
 * So on this wire a loaded tool is shown where it was loaded instead: the
 * tool_search result carries each loaded tool's definition, and the tool stays
 * out of `tools`. Everything before the result is byte-identical to the request
 * before. The model calls the tool by name; the op already holds it
 * (tool-augmentation.ts), so the call runs like any other, and its arguments are
 * typed against the schema there (tool-execution/arg-repair.ts coerceArgs).
 *
 * Only where Ollama passes a call to a tool outside `tools` through: its
 * generic parser (tools/tools.go findTool) drops one, while the qwen3.5 parser
 * keeps the name as written and leaves untyped arguments as strings (Ollama
 * model/parsers/qwen3coder.go, read 2026-11-06). Other models keep the
 * load-into-`tools` behavior and its one re-read.
 *
 * A pure function of the history and the request's tools, as the cache needs
 * (cache-prefix rule): the loaded names come from the result itself, which
 * pruning never stubs. The definition shown is the op's own, so a result
 * renders the same every request while the op holds the tool. A tool the search
 * named that the request already carried (the model searched for one it had)
 * moves out of `tools` too: one re-read, then stable.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolDefinition } from "../../../types.js";
import type { LocalModel } from "../../../local-runtimes/types.js";
import { formatToolSearchResultWithSchemas, toolSearchResultNames } from "../../../tools/tool-search-result.js";

const SEARCH_TOOL = "tool_search";

/** Ollama tool-call parsers that keep a call to a tool outside `tools`. */
const PASS_THROUGH_PARSERS: ReadonlySet<string> = new Set(["qwen3.5"]);

/** Whether this model's loads are shown inline: it is served over Ollama's
 *  native /api/chat and its parser passes unknown tool names through. */
export function inlinesToolLoads(nativeOllama: boolean, model: Pick<LocalModel, "toolParser"> | null): boolean {
  return nativeOllama && !!model?.toolParser && PASS_THROUGH_PARSERS.has(model.toolParser);
}

type WireTool = Pick<ToolDefinition, "name" | "description" | "parameters">;

/**
 * Each tool_search result whose loaded tools this request carries is rewritten
 * to carry their definitions, and those tools leave `tools`. The input is not
 * mutated.
 */
export function inlineToolLoads<T extends WireTool>(
  messages: readonly ChatCompletionMessageParam[],
  tools: readonly T[],
): { messages: ChatCompletionMessageParam[]; tools: T[] } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const searchCalls = new Set<string>();
  const inlined = new Set<string>();
  const out = messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        if (call.type === "function" && call.function.name === SEARCH_TOOL) searchCalls.add(call.id);
      }
      return m;
    }
    if (m.role !== "tool" || !searchCalls.has(m.tool_call_id) || typeof m.content !== "string") return m;
    const loaded = [...new Set(toolSearchResultNames(m.content))].flatMap((n) => byName.get(n) ?? []);
    if (loaded.length === 0) return m;
    for (const t of loaded) inlined.add(t.name);
    const content = formatToolSearchResultWithSchemas(
      loaded.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} })),
    );
    return { ...m, content };
  });
  if (inlined.size === 0) return { messages: out, tools: [...tools] };
  return { messages: out, tools: tools.filter((t) => !inlined.has(t.name)) };
}

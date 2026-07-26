/**
 * Tool Prompt Builder — generates system prompt sections from tool definitions.
 * Each tool can contribute natural-language usage instructions via a prompt() function.
 * These get injected into the system prompt to teach the LLM best practices.
 */
import type { ToolDefinition } from "../types.js";

interface ToolWithPrompt extends ToolDefinition {
  _prompt?: () => string;
  _category?: string;
}

/** Attach a prompt function to a tool definition (non-destructive) */
export function withPrompt(tool: ToolDefinition, promptFn: () => string, category?: string): ToolDefinition {
  const t = tool as ToolWithPrompt;
  t._prompt = promptFn;
  if (category) t._category = category;
  return t;
}

/** Collect all tool prompt() outputs into a system prompt section */
export function buildToolPromptSection(tools: ToolDefinition[]): string {
  const lines: string[] = [];
  for (const tool of tools) {
    const t = tool as ToolWithPrompt;
    if (!t._prompt) continue;
    const text = t._prompt().trim();
    if (text) lines.push(`- **${t.name}**: ${text}`);
  }
  if (lines.length === 0) return "";
  return `\n\n## Tool Best Practices\n${lines.join("\n")}\n`;
}

/** First sentence of a tool description, whitespace-collapsed and length-capped,
 *  for a one-line manifest entry. Falls back to the whole (capped) string when
 *  there's no sentence terminator. */
function firstSentence(desc: string, cap = 140): string {
  const flat = desc.trim().replace(/\s+/g, " ");
  const m = flat.match(/^(.*?[.!?])(?:\s|$)/);
  let s = m ? m[1] : flat;
  if (s.length > cap) s = s.slice(0, cap - 1).trimEnd() + "…";
  return s;
}

/** Hard ceiling on manifest entries so a pathological MCP fan-out can't bloat
 *  the prompt. Overflow is disclosed to the model, not silently dropped. */
const MANIFEST_MAX = 250;

/**
 * Deferred-tool name manifest — companion to buildToolPromptSection().
 *
 * The per-turn API schema ships only the LOADED tools (the eager audience ∪
 * keyword ∪ literal ∪ RAG set that selectTools() resolves). Every other
 * registered tool is DEFERRED: its full schema is NOT in the request, so
 * without this block the model can't see the tool exists and either
 * fail-discovers or flatly denies the capability. That invisibility is the
 * only reason the Anthropic-strong path used to ship the entire inventory and
 * eat the cold cache-write.
 *
 * This lists the deferred tools by NAME + a one-line description so the model
 * knows the capability exists and loads the schema on demand via `tool_search`
 * (the canonical loader, always eager). It rides the system prompt, which is
 * NOT cache-anchored (only the tools array is — see stream-api.ts), so its
 * per-turn variance costs nothing on the cached tools block.
 *
 * What this function guarantees, exactly: the manifest is `all − loaded`. So
 * given an `all` that is the AVAILABILITY-FILTERED catalog (filterAvailableTools
 * in tool-search.ts — which is what the caller in build-system-prompt.ts
 * passes), two things hold:
 *
 *  1. NO UNAVAILABLE TOOL IS NAMED HERE. A tool withheld from the schema by its
 *     `available()` predicate must not reappear by name in the manifest, or the
 *     model is merely told to tool_search for a capability this machine doesn't
 *     have. This is the property the gate exists for and it is airtight, because
 *     the manifest is a SUBSET of `all`.
 *  2. EVERY AVAILABLE TOOL IS REACHABLE — each one is either in `loaded` (its
 *     schema shipped) or named here, so no usable tool is fully invisible.
 *
 * What is NOT guaranteed, and was previously claimed here as the invariant
 * `loaded ∪ manifested = available catalog`: that the UNION contains only
 * available tools. `loaded` is chosen upstream by selectTools()
 * (src/agent-request/prepare-request/tool-selection.ts), which re-derives its
 * result from the RAW `allAgentTools` after the gate has run — the RAG union,
 * the provider tool cap, the tool_search re-add and the product-build route all
 * select out of the unfiltered catalog. An unavailable tool can therefore land
 * in `loaded` and ship its schema. That direction is fail-OPEN (a tool that
 * cannot work is advertised and returns a clear error) and is identical to the
 * behaviour on main, which is why it is documented rather than "fixed" here:
 * narrowing at that seam would convert the riskiest tool-selection path in the
 * request pipeline from fail-open to fail-closed. This function cannot repair it
 * either — it only ever removes names, never adds them.
 *
 * Pure: `loaded` is the exact per-turn set and the manifest is its complement.
 */
export function buildDeferredToolManifest(
  all: ToolDefinition[],
  loaded: ToolDefinition[],
): string {
  const loadedNames = new Set(loaded.map((t) => t.name));
  const deferred = all.filter((t) => !loadedNames.has(t.name));
  if (deferred.length === 0) return "";

  const shown = deferred.slice(0, MANIFEST_MAX);
  const overflow = deferred.length - shown.length;
  const lines = shown.map((t) => `- ${t.name}: ${firstSentence(t.description)}`);
  if (overflow > 0) {
    lines.push(`- …and ${overflow} more — call \`tool_search\` with a keyword to find them.`);
  }

  return (
    `\n\n## More tools available on demand (${deferred.length})\n` +
    `These tools exist but their full schemas are NOT loaded this turn. To use one, ` +
    `call \`tool_search\` (describe what you need, or pass the exact name), then call the ` +
    `tool it returns. This list is exhaustive: never tell the user a capability is ` +
    `missing or that you lack a tool without first calling \`tool_search\`. The tools ` +
    `loaded above take precedence when they already cover the need.\n` +
    lines.join("\n") +
    `\n`
  );
}

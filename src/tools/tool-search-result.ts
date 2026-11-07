/**
 * The tool_search result: which tools a search loaded. One format, written by
 * the tool (tool-search.ts) and read back by everything that acts on a load —
 * the op's tool set (canonical-loop/tool-augmentation.ts) and a provider that
 * loads tools inline (anthropic-client/deferred-tools.ts). A leaf: no imports,
 * so a transport can read it without pulling in the registry.
 */

/** A JSON array of `{ name, description }`, one per tool loaded. */
export function formatToolSearchResult(tools: ReadonlyArray<{ name: string; description: string }>): string {
  return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description })), null, 2);
}

/** A result that also carries each loaded tool's parameters, for a wire that
 *  shows a loaded tool's definition in the conversation instead of the tool
 *  list (canonical-loop/adapters/openai-compat/local-tool-loads.ts). Read
 *  back by toolSearchResultNames like the plain form. */
export function formatToolSearchResultWithSchemas(
  tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>,
): string {
  return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), null, 2);
}

/** The tool names a tool_search result loaded; none for anything else (an
 *  error, or "No tools matched the query."). */
export function toolSearchResultNames(content: string): string[] {
  if (!content.trim().startsWith("[")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return []; // not a result list: it loaded nothing
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => (e && typeof e === "object" ? (e as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

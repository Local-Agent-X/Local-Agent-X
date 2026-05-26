import { resolve, relative } from "node:path";
import type { MemoryIndex } from "../../../memory.js";

export function memorySearchTool(memory: MemoryIndex) {
  return {
    name: "memory_search",
    description:
      "Search long-term memory for retained facts, knowledge files, and entity pages. Defaults to same-session + profile-level content only — past sessions are NOT included by default. To explicitly pull from prior conversations, use `search_past_sessions` instead. Use this for: what did the user write down about X, what's stored in USER.md or an entity page, what facts have been retained about an entity.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default 6)" },
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by canonical source. One or more of: entity, daily-log, session-summary, session, personality, import (default: all)",
        },
        entity: {
          type: "string",
          description: "Filter results to a specific entity (e.g. a person's name).",
        },
        since: {
          type: "string",
          description: "Only return results after this date (ISO format, e.g. 2026-03-01)",
        },
        project: { type: "string", description: "Filter by project name" },
        source_type: {
          type: "string",
          description: "Filter by source type: agent-x-session, chatgpt-import, claude-import, memory-file, entity-page, import",
        },
        date_from: { type: "string", description: "Start date filter (ISO format)" },
        date_to: { type: "string", description: "End date filter (ISO format)" },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>) {
      const query = String(args.query || "");
      const maxResults = (args.max_results as number) || 6;
      const sources = args.sources as string[] | undefined;
      const entity = args.entity ? String(args.entity) : undefined;
      const since = args.since ? new Date(String(args.since)) : undefined;
      const project = args.project ? String(args.project) : undefined;
      const sourceType = args.source_type ? String(args.source_type) : undefined;
      const dateFrom = args.date_from ? String(args.date_from) : undefined;
      const dateTo = args.date_to ? String(args.date_to) : undefined;
      // _sessionId is injected by tool-executor for SESSION_SCOPED_TOOLS.
      // When present, default behavior is same-session + profile only.
      // Past sessions require the explicit `search_past_sessions` tool.
      const sessionId = args._sessionId ? String(args._sessionId) : undefined;

      const results = await memory.search(query, {
        maxResults,
        sources,
        entities: entity ? [entity] : undefined,
        since,
        project,
        sourceType,
        dateFrom,
        dateTo,
        sessionId,
      });

      if (results.length === 0) {
        return { content: "<search_results count=\"0\">No relevant memories found.</search_results>" };
      }

      // Strip the long absolute prefix when possible so the model sees
      // `bank/entities/peter.md` instead of `/home/.../bank/entities/peter.md`.
      const memDir = resolve(memory["memoryDir"]);
      const formatted = results
        .map((r, i) => {
          let virtualPath = r.path;
          try {
            const rel = relative(memDir, r.path);
            if (rel && !rel.startsWith("..")) virtualPath = rel;
          } catch { /* fall back to absolute */ }
          const ent = r.entities?.length ? ` entities=${r.entities.join(",")}` : "";
          return `[${i + 1}] source=${r.source} path=${virtualPath}:${r.startLine}-${r.endLine} score=${r.score.toFixed(2)}${ent}\n${r.snippet}`;
        })
        .join("\n\n");

      // Wrap in XML with a leading instruction so the model treats this as
      // reference material, not draft output. Anthropic/OpenAI models are
      // trained to respect <tag>...</tag> boundaries as non-quoted context.
      const wrapped =
        `<search_results count="${results.length}" query="${query.replace(/"/g, "&quot;").slice(0, 100)}">\n` +
        `INSTRUCTION: The text below contains snippets from your own memory retrieved for reference.\n` +
        `Use the information to answer the user's question. DO NOT paste these snippets verbatim\n` +
        `into your reply — they include old user/assistant turns that aren't your current response.\n` +
        `Summarize the relevant facts in your own words.\n\n` +
        formatted + "\n" +
        `</search_results>`;

      return { content: wrapped };
    },
  };
}

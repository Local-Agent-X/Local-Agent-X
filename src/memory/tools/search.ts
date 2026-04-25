import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { MemoryIndex } from "../../memory.js";
import type { FactKind, RetainedFact } from "../types.js";

export function createSearchTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_search",
      description:
        "Search long-term memory for relevant information from past conversations, notes, knowledge files, and retained facts. Use when the user references something from a previous session or when you need context about past decisions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "number", description: "Max results (default 6)" },
          sources: {
            type: "array",
            items: { type: "string" },
            description:
              "Filter by canonical source. One or more of: entity, daily-log, mind, session-summary, session, personality, import (default: all)",
          },
          entity: {
            type: "string",
            description: "Filter results to a specific entity (e.g. 'Alex')",
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

        const results = await memory.search(query, {
          maxResults,
          sources,
          entities: entity ? [entity] : undefined,
          since,
          project,
          sourceType,
          dateFrom,
          dateTo,
        });

        if (results.length === 0) {
          return { content: "<search_results count=\"0\">No relevant memories found.</search_results>" };
        }

        // Surface the canonical source + a path that's readable across stores.
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
    },

    {
      name: "memory_reindex",
      description:
        "Force-reindex memory stores. Run if memory_search seems to be missing recently-written facts, or after a manual edit to a memory file. Returns chunk counts per store. Idempotent — already-indexed content costs nothing to re-check.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "One of: all, entity, daily-log, mind, session-summary, session, personality (default: all)",
          },
          force: {
            type: "boolean",
            description:
              "If true, drop existing chunks for the targeted source(s) before reindexing. Re-embeds everything. Default false (cheap content-hash dedup).",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const source = args.source ? String(args.source) : "all";
        const force = !!args.force;
        try {
          const { getUniversalIndex } = await import("../universal-index.js");
          const ui = getUniversalIndex();
          if (!ui) {
            return { content: "BLOCKED: universal-index not initialized.", isError: true };
          }
          if (source === "all") {
            const report = await ui.backfillAll({ force });
            return {
              content: JSON.stringify({ ok: true, ...report }, null, 2),
            };
          } else {
            const valid = ["entity", "daily-log", "mind", "session-summary", "session", "personality"];
            if (!valid.includes(source)) {
              return { content: `BLOCKED: unknown source "${source}". Valid: ${valid.join(", ")}, all`, isError: true };
            }
            const added = await ui.reindexStore(source as "entity" | "daily-log" | "mind" | "session-summary" | "session" | "personality");
            return { content: JSON.stringify({ ok: true, source, chunksAdded: added }, null, 2) };
          }
        } catch (e) {
          return { content: `Reindex failed: ${(e as Error).message}`, isError: true };
        }
      },
    },

    {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use to retrieve MIND.md, a daily log, or an entity page.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path within memory dir (e.g. MIND.md, 2026-03-22.md, bank/entities/peter.md)",
          },
        },
        required: ["path"],
      },
      async execute(args: Record<string, unknown>) {
        const requestedPath = String(args.path || "");

        // Path traversal protection: resolve and verify it stays within memory dir
        const memDir = resolve(memory["memoryDir"]);
        const fullPath = resolve(memDir, requestedPath);
        const rel = relative(memDir, fullPath);
        if (rel.startsWith("..") || isAbsolute(requestedPath)) {
          return {
            content: "BLOCKED: path traversal detected. Only files within the memory directory are accessible.",
            isError: true,
          };
        }

        if (!existsSync(fullPath)) {
          return { content: `Memory file not found: ${requestedPath}` };
        }

        try {
          const content = readFileSync(fullPath, "utf-8");
          return { content: content || "(empty file)" };
        } catch (e) {
          return {
            content: `Error reading memory file: ${(e as Error).message}`,
            isError: true,
          };
        }
      },
    },

    {
      name: "memory_recall",
      description:
        "Recall structured facts about an entity, by time period, or by fact kind. Use for entity-centric queries ('tell me about X'), temporal queries ('what happened last week'), or opinion queries ('what does X prefer').",
      parameters: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "Entity name/slug to recall facts about",
          },
          kind: {
            type: "string",
            enum: ["world", "experience", "opinion", "observation"],
            description: "Filter by fact kind",
          },
          since: {
            type: "string",
            description: "Recall facts since this date (ISO format)",
          },
          until: {
            type: "string",
            description: "Recall facts until this date (ISO format)",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const entity = args.entity ? String(args.entity) : undefined;
        const kind = args.kind as FactKind | undefined;
        const since = args.since ? new Date(String(args.since)) : undefined;
        const until = args.until ? new Date(String(args.until)) : undefined;

        let facts: RetainedFact[] = [];

        if (entity && kind === "opinion") {
          facts = memory.recallOpinions(entity);
        } else if (entity) {
          facts = memory.recallByEntity(entity);
        } else if (kind) {
          facts = memory.recallByKind(kind);
        } else if (since) {
          facts = memory.recallByTime(since, until || undefined);
        } else {
          return { content: "Provide at least one filter: entity, kind, or since." };
        }

        if (facts.length === 0) {
          return { content: "No facts found matching the query." };
        }

        const formatted = facts
          .map((f, i) => {
            const date = new Date(f.timestamp).toISOString().split("T")[0];
            const conf = f.kind === "opinion" ? ` (c=${f.confidence.toFixed(2)})` : "";
            const ents = f.entities.length > 0 ? ` @${f.entities.join(" @")}` : "";
            return `[${i + 1}] [${f.kind}]${conf}${ents} ${f.content} — ${date} (${f.sourceFile}#L${f.sourceLine})`;
          })
          .join("\n");

        return { content: formatted };
      },
    },

    {
      name: "memory_stats",
      description: "Get memory system statistics: chunks, files, facts, entities, cache size.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const stats = memory.getStats();
        return {
          content: [
            `Indexed files: ${stats.totalFiles}`,
            `Chunks: ${stats.totalChunks}`,
            `Retained facts: ${stats.totalFacts}`,
            `Known entities: ${stats.totalEntities}`,
            `Embedding cache: ${stats.cacheSize} entries`,
            `FTS5: ${stats.hasFts ? "active" : "unavailable"}`,
            `sqlite-vec: ${stats.hasVec ? "active" : "unavailable (using in-memory cosine)"}`,
          ].join("\n"),
        };
      },
    },
  ];
}

/**
 * Memory tools exposed to the agent loop.
 *
 * memory_search, memory_save, memory_forget, memory_recall, memory_stats,
 * memory_update_profile, memory_ingest, memory_consolidate — everything the
 * agent can call to read/write persistent memory.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { MemoryIndex } from "../memory.js";
import type { FactKind, RetainedFact } from "./types.js";
import { slugify, atomicWriteFileSync } from "./utils.js";
import { PERSONALITY_FILES } from "./personality.js";

// ── Deep-forget helpers (redact from profile files + daily logs) ──

/** Remove or redact mentions of `term` from USER.md, MIND.md, HEART.md. */
function redactFromProfileFiles(memDir: string, term: string): number {
  const termLower = term.toLowerCase();
  const termRe = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let filesChanged = 0;

  for (const [, filename] of Object.entries(PERSONALITY_FILES)) {
    const filePath = join(memDir, filename);
    if (!existsSync(filePath)) continue;
    const original = readFileSync(filePath, "utf-8");
    if (!original.toLowerCase().includes(termLower)) continue;

    // Line-by-line: remove lines that are PRIMARILY about the term,
    // redact the term from lines that mention it alongside other things.
    const lines = original.split("\n");
    const newLines: string[] = [];
    for (const line of lines) {
      if (!line.toLowerCase().includes(termLower)) {
        newLines.push(line);
        continue;
      }
      // If the line is a bullet/list item and >50% of non-filler content is the term, drop it
      const stripped = line.replace(/^[\s\-*#>]+/, "").trim();
      if (stripped.toLowerCase() === termLower || stripped.toLowerCase().startsWith(termLower + " ") && stripped.length < term.length + 20) {
        continue; // drop entire line — it's primarily about the term
      }
      // Otherwise redact the term inline (e.g., "kids (PJM, MJM, AJM)" → "kids (PJM, MJM)")
      let redacted = line.replace(termRe, "").replace(/,\s*,/g, ",").replace(/,\s*\)/g, ")").replace(/\(\s*,/g, "(").replace(/\s{2,}/g, " ").trim();
      if (redacted) newLines.push(redacted);
    }
    const result = newLines.join("\n");
    if (result !== original) {
      atomicWriteFileSync(filePath, result);
      filesChanged++;
    }
  }
  return filesChanged;
}

/** Redact mentions of `term` from today's daily log + recent logs. */
function redactFromDailyLogs(memDir: string, term: string, daysBack = 7): number {
  const termRe = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let linesRedacted = 0;

  const files: string[] = [];
  try {
    for (const f of readdirSync(memDir)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) files.push(f);
    }
  } catch { return 0; }

  // Only process recent logs (default last 7 days)
  const cutoff = Date.now() - daysBack * 86_400_000;
  for (const f of files) {
    const dateStr = f.replace(".md", "");
    if (new Date(dateStr).getTime() < cutoff) continue;

    const filePath = join(memDir, f);
    const content = readFileSync(filePath, "utf-8");
    if (!content.toLowerCase().includes(term.toLowerCase())) continue;

    const lines = content.split("\n");
    const newLines = lines.map(line => {
      if (!line.toLowerCase().includes(term.toLowerCase())) return line;
      linesRedacted++;
      return line.replace(termRe, "[REDACTED]");
    });
    atomicWriteFileSync(filePath, newLines.join("\n"));
  }
  return linesRedacted;
}

//  MEMORY TOOLS FOR AGENT
// ══════════════════════════════════════════════════════════

export function createMemoryTools(memory: MemoryIndex) {
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
              "Filter by source: 'memory', 'sessions', 'entities' (default: all)",
          },
          entity: {
            type: "string",
            description: "Filter results to a specific entity (e.g. 'Peter')",
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
          return { content: "No relevant memories found." };
        }

        const formatted = results
          .map(
            (r, i) =>
              `[${i + 1}] (score: ${r.score.toFixed(2)}, ${r.source}${r.entities?.length ? `, entities: ${r.entities.join(",")}` : ""}) ${r.path}:${r.startLine}-${r.endLine}\n${r.snippet}`
          )
          .join("\n\n");

        return { content: formatted };
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
      name: "memory_save",
      description:
        "Save important information to long-term memory. Targets: 'daily' (conversation log), 'memory' (curated MIND.md facts), 'retain' (structured fact with type/entity/confidence for the Retain system).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          target: {
            type: "string",
            enum: ["daily", "memory", "retain"],
            description:
              "'daily' for daily log (default), 'memory' for MIND.md, 'retain' for structured fact",
          },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        let content = String(args.content || "");
        const target = String(args.target || "daily");

        if (!content.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        // Memory taint protection: block external/injected content from persisting
        // This prevents the attack chain: malicious webpage → memory_save → permanent instruction hijack
        try {
          const { checkMemoryTaint, sanitizeForMemory, stripControlChars, normalizeHomoglyphs } = await import("../sanitize.js");
          // Step 1: Cryptographic normalization — strip ALL unicode tricks before checking
          content = normalizeHomoglyphs(stripControlChars(content));
          // Step 2: Taint check on normalized content
          const taint = checkMemoryTaint(content);
          if (!taint.safe) {
            return {
              content: `BLOCKED: ${taint.reason}`,
              isError: true,
            };
          }
          // Step 3: Final sanitization pass (strip any remaining markers)
          content = sanitizeForMemory(content);
        } catch {
          // Sanitize module not available — allow (fail-open for backwards compat)
        }

        if (target === "memory") {
          const existing = memory.readMemoryFile();
          memory.writeMemoryFile(existing + (existing ? "\n\n" : "") + content);
          return { content: "Saved to MIND.md" };
        } else if (target === "retain") {
          // Parse structured fact line(s)
          const facts = memory.retain(content, "agent-tool");
          if (facts.length === 0) {
            // If not in structured format, save as observation
            const facts2 = memory.retain(
              `- S ${content}`,
              "agent-tool"
            );
            return {
              content: `Retained ${facts2.length} fact(s) as observation`,
            };
          }
          return {
            content: `Retained ${facts.length} fact(s): ${facts.map((f) => `[${f.kind}] ${f.content.slice(0, 60)}`).join("; ")}`,
          };
        } else {
          memory.appendDailyLog(content);
          return {
            content: `Saved to daily log (${new Date().toISOString().split("T")[0]})`,
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
      name: "memory_reflect",
      description:
        "Trigger a reflection cycle: updates entity summary pages and opinion confidence scores based on recent facts. Call periodically or when asked to 'reflect' or 'update what you know'.",
      parameters: {
        type: "object",
        properties: {
          since_days: {
            type: "number",
            description: "How many days back to consider (default 7)",
          },
        },
      },
      async execute(args: Record<string, unknown>) {
        const sinceDays = (args.since_days as number) || 7;
        const result = await memory.reflect(sinceDays);
        return {
          content: `Reflection complete. Updated ${result.entitiesUpdated.length} entity pages (${result.entitiesUpdated.join(", ") || "none"}), ${result.opinionsUpdated} opinions.`,
        };
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

    {
      name: "memory_forget",
      description:
        "Delete specific memories. Use when the user asks to forget something, remove incorrect info, or delete test data. " +
        "Can delete by: search query (finds and removes matching chunks), fact content (removes specific retained facts), " +
        "conversation ID (removes all chunks from a specific imported conversation), or path pattern.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — finds matching chunks and deletes them" },
          fact: { type: "string", description: "Exact or partial fact text to remove from retained facts" },
          conversation_id: { type: "string", description: "Conversation ID to remove (from imported chats)" },
          path: { type: "string", description: "Path pattern to delete chunks from (e.g. 'import/chatgpt/abc123')" },
          confirm: { type: "boolean", description: "Must be true to actually delete. If false or missing, shows what would be deleted." },
        },
      },
      async execute(args: Record<string, unknown>) {
        const query = args.query ? String(args.query) : undefined;
        const fact = args.fact ? String(args.fact) : undefined;
        const conversationId = args.conversation_id ? String(args.conversation_id) : undefined;
        const pathPattern = args.path ? String(args.path) : undefined;
        const confirm = args.confirm === true;

        const results: string[] = [];

        if (fact) {
          const matching = memory.findFacts(fact);
          if (!confirm) {
            results.push(`Would delete ${matching.length} fact(s):`);
            matching.slice(0, 10).forEach(f => results.push(`  - ${f.content.slice(0, 80)}`));
          } else {
            const deleted = memory.forgetFacts(fact);
            results.push(`Deleted ${deleted} fact(s)`);
          }
        }

        if (query) {
          const searchResults = await memory.search(query, { maxResults: 20, minScore: 0.3 });
          if (!confirm) {
            results.push(`Would delete ${searchResults.length} matching memory chunk(s):`);
            searchResults.slice(0, 10).forEach(r => results.push(`  - [${r.source}] ${r.snippet.slice(0, 60)}`));
          } else {
            let deleted = 0;
            for (const r of searchResults) {
              deleted += memory.forgetChunks(r.path);
            }
            results.push(`Deleted ${deleted} chunk(s) matching "${query}"`);
          }
        }

        if (conversationId) {
          const count = memory.countChunks(conversationId);
          if (!confirm) {
            results.push(`Would delete ${count} chunk(s) from conversation ${conversationId}`);
          } else {
            const deleted = memory.forgetConversation(conversationId);
            results.push(`Deleted ${deleted} chunk(s) from conversation ${conversationId}`);
          }
        }

        if (pathPattern) {
          const count = memory.countChunks(pathPattern);
          if (!confirm) {
            results.push(`Would delete ${count} chunk(s) matching path "${pathPattern}"`);
          } else {
            const deleted = memory.forgetChunks(pathPattern);
            results.push(`Deleted ${deleted} chunk(s) matching "${pathPattern}"`);
          }
        }

        if (results.length === 0) {
          return { content: "Provide at least one of: query, fact, conversation_id, or path to specify what to forget.", isError: true };
        }

        // Deep forget: also scrub profile files + daily logs so the term
        // doesn't resurface via USER.md/MIND.md/daily log context injection.
        if (confirm) {
          const term = fact || query || "";
          if (term.length >= 2) {
            const memDir = (memory as unknown as { memoryDir: string }).memoryDir;
            const profilesChanged = redactFromProfileFiles(memDir, term);
            const logsRedacted = redactFromDailyLogs(memDir, term);
            if (profilesChanged > 0) results.push(`Redacted "${term}" from ${profilesChanged} profile file(s)`);
            if (logsRedacted > 0) results.push(`Redacted ${logsRedacted} line(s) in daily logs`);
          }
        }

        if (!confirm) {
          results.push("\nTo confirm deletion, call memory_forget again with confirm: true");
        }

        return { content: results.join("\n") };
      },
    },

    {
      name: "memory_update_profile",
      description:
        "Update a personality/profile file. Use this to evolve knowledge about the user or to adjust agent behavior based on what you learn. Files: 'user' (USER.md — who they are), 'heart' (HEART.md — your personality), 'identity' (IDENTITY.md — your name/vibe), 'mind' or 'memory' (MIND.md — core facts/knowledge). You can replace specific sections or append new information.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            enum: ["user", "heart", "identity", "mind", "memory"],
            description: "Which profile file to update",
          },
          action: {
            type: "string",
            enum: ["replace_section", "append", "full_replace"],
            description:
              "'replace_section' to find and replace a section by heading, 'append' to add at the end, 'full_replace' to overwrite the entire file",
          },
          section_heading: {
            type: "string",
            description:
              "For replace_section: the ## heading to find (e.g. 'Family & People')",
          },
          content: {
            type: "string",
            description: "The new content to write",
          },
        },
        required: ["file", "action", "content"],
      },
      async execute(args: Record<string, unknown>) {
        const fileKey = String(args.file || "") as keyof typeof PERSONALITY_FILES;
        const action = String(args.action || "append");
        const newContent = String(args.content || "");

        if (!newContent.trim()) {
          return { content: "Nothing to write.", isError: true };
        }

        const filename = PERSONALITY_FILES[fileKey];
        if (!filename) {
          return {
            content: `Unknown file: ${fileKey}. Use: user, heart, identity, mind, or memory`,
            isError: true,
          };
        }

        const filePath = join(memory["memoryDir"], filename);
        const existing = existsSync(filePath)
          ? readFileSync(filePath, "utf-8")
          : "";

        let updated: string;

        if (action === "full_replace") {
          // Safety: require minimum content length to prevent accidental wipe
          if (newContent.trim().length < 20) {
            return {
              content:
                "full_replace requires at least 20 characters of content to prevent accidental wipe.",
              isError: true,
            };
          }
          // Backup the existing file before full replace
          if (existing.trim()) {
            const backupPath = filePath + ".bak";
            try {
              atomicWriteFileSync(backupPath, existing);
            } catch {}
          }
          updated = newContent;
        } else if (action === "append") {
          updated = existing + "\n\n" + newContent;
        } else if (action === "replace_section") {
          const heading = String(args.section_heading || "");
          if (!heading) {
            return {
              content: "section_heading required for replace_section",
              isError: true,
            };
          }

          // Find section by heading and replace it
          const headingPattern = new RegExp(
            `(^|\\n)(##?\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*)([\\s\\S]*?)(?=\\n##?\\s|$)`,
            "i"
          );

          const match = existing.match(headingPattern);
          if (match) {
            updated = existing.replace(
              headingPattern,
              `$1$2\n${newContent}`
            );
          } else {
            // Section not found — append as new section
            updated = existing + `\n\n## ${heading}\n${newContent}`;
          }
        } else {
          return { content: `Unknown action: ${action}`, isError: true };
        }

        atomicWriteFileSync(filePath, updated);
        memory.markDirty();

        return {
          content: `Updated ${filename} (${action}${action === "replace_section" ? `: ${args.section_heading}` : ""})`,
        };
      },
    },

    // Conversation ingest tool
    {
      name: "memory_ingest",
      description:
        "Ingest conversation history from exported chat files into long-term memory. " +
        "Supports ChatGPT, Claude.ai, Claude Code, OpenAI Codex CLI, Slack, and generic JSON. " +
        "Auto-detects format. Incremental — skips already-ingested conversations.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Path to directory containing export files" },
          file: { type: "string", description: "Path to a single export file (alternative to directory)" },
        },
      },
      async execute(args: Record<string, unknown>) {
        const dir = args.directory ? String(args.directory) : undefined;
        const file = args.file ? String(args.file) : undefined;
        const target = dir || file;
        if (!target) return { content: "Provide either 'directory' or 'file' parameter.", isError: true };
        const onProgress = typeof args._onProgress === "function" ? args._onProgress as (msg: string) => void : undefined;

        try {
          const { ingestConversations } = await import("../conversation-ingest.js");
          const result = await ingestConversations(memory, target, (p) => {
            const total = p.totalConversations || 1;
            const done = p.processed + p.skipped;
            const pct = Math.round((done / total) * 100);
            onProgress?.(`${pct}%|${done}/${total} conversations, ${p.chunksCreated} chunks|${p.currentFile}`);
          });
          const fmtList = Object.entries(result.formats).map(([k, v]) => `${k}: ${v}`).join(", ");
          return {
            content: [
              `Ingest complete.`,
              `Conversations: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`,
              `Chunks created: ${result.chunksCreated}`,
              `Formats: ${fmtList || "none"}`,
              `Total in database: ${memory.getIngestStats().total}`,
            ].join("\n"),
          };
        } catch (e) {
          return { content: `Ingest failed: ${(e as Error).message}`, isError: true };
        }
      },
    },

    {
      name: "memory_consolidate",
      description:
        "Run sleeptime memory consolidation. Pulls recent conversation chunks, " +
        "asks an LLM to extract durable facts (preferences, decisions, plans, world facts), " +
        "and writes them through the resolver so duplicates are skipped and contradictions update " +
        "existing facts via bi-temporal invalidation. Safe to run repeatedly. " +
        "Intended for nightly cron — expensive to run ad-hoc unless you just ingested a lot of data.",
      parameters: {
        type: "object",
        properties: {
          lookbackHours: { type: "number", description: "How far back to look (default 24)" },
          dryRun: { type: "boolean", description: "Extract facts but don't write them (default false)" },
          provider: { type: "string", enum: ["ollama", "anthropic", "openai", "auto"], description: "Which LLM to use (default auto)" },
          model: { type: "string", description: "Override default model for the chosen provider" },
        },
      },
      async execute(args: Record<string, unknown>) {
        const { runSleeptimeConsolidation } = await import("../memory-sleeptime.js");
        const result = await runSleeptimeConsolidation(memory, {
          lookbackHours: typeof args.lookbackHours === "number" ? args.lookbackHours : undefined,
          dryRun: Boolean(args.dryRun),
          provider: args.provider as "ollama" | "anthropic" | "openai" | "auto" | undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        const elapsed = ((result.finishedAt - result.startedAt) / 1000).toFixed(1);
        const ops = result.operations;
        const lines = [
          `Consolidation ${args.dryRun ? "(dry run) " : ""}complete in ${elapsed}s`,
          `  Lookback: ${result.lookbackHours}h`,
          `  Sessions analyzed: ${result.sessionsAnalyzed}`,
          `  Chunks analyzed: ${result.chunksAnalyzed}`,
          `  Facts extracted: ${result.factsExtracted}`,
          `  Operations: add=${ops.add} update=${ops.update} delete=${ops.delete} noop=${ops.noop}`,
          result.errors.length > 0 ? `  Errors: ${result.errors.length}` : "",
        ].filter(Boolean);
        if (result.decisions.length > 0 && result.decisions.length <= 10) {
          lines.push("", "Decisions:");
          for (const d of result.decisions) {
            const target = d.targetId ? ` → id=${d.targetId}` : "";
            lines.push(`  [${d.op}${target}] ${d.content} (${d.reason})`);
          }
        }
        return { content: lines.join("\n") };
      },
    },
  ];
}

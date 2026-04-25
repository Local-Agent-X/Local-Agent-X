import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../../memory.js";
import { atomicWriteFileSync } from "../utils.js";
import { PERSONALITY_FILES } from "../personality.js";

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
      // Otherwise redact the term inline (e.g., "kids (PJM, MJM, RileyM)" → "kids (PJM, MJM)")
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

export function createForgetTool(memory: MemoryIndex) {
  return {
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
  };
}

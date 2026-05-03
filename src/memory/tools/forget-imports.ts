import type { MemoryIndex } from "../../memory.js";

// Bulk-delete imported memories by source or recency. Read-only when called
// without `confirm: true` — returns a preview of what would be removed.
export function createForgetImportsTool(memory: MemoryIndex) {
  return {
    name: "memory_forget_imports",
    description:
      "Manage memories that were imported from other AI agents/tools. " +
      "Default action is to list every import source with counts. " +
      "Pass `source` to bulk-delete everything from one source (e.g. 'chatgpt', 'sqlite-messages'). " +
      "Pass `since_minutes` to undo recent imports. " +
      "All deletes require `confirm: true`. Without confirm, shows a dry-run preview.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source format to forget (e.g. 'chatgpt', 'claude-ai', 'sqlite-messages'). Run with no args to see available sources.",
        },
        since_minutes: {
          type: "number",
          description: "Forget all imports done in the last N minutes. Useful for undoing the last import batch.",
        },
        confirm: {
          type: "boolean",
          description: "Must be true to actually delete. Without it, this tool only previews what would be removed.",
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const source = args.source ? String(args.source) : undefined;
      const sinceMinutes = typeof args.since_minutes === "number" ? args.since_minutes : undefined;
      const confirm = args.confirm === true;

      // No filter → just list current imports
      if (!source && sinceMinutes === undefined) {
        return { content: formatSummary(memory) };
      }

      const targets = collectTargets(memory, source, sinceMinutes);
      if (targets.length === 0) {
        const filterDesc = source ? `source "${source}"` : `last ${sinceMinutes} min`;
        return { content: `No imports match ${filterDesc}.\n\n${formatSummary(memory)}` };
      }

      if (!confirm) {
        const preview = targets.slice(0, 15).map(t => {
          const ago = humanAgo(Date.now() - t.ingested_at);
          return `  - [${t.source_format}] ${t.title || t.conversation_id} (imported ${ago})`;
        }).join("\n");
        const more = targets.length > 15 ? `\n  ... and ${targets.length - 15} more` : "";
        return {
          content: [
            `Would delete ${targets.length} imported conversation(s):`,
            preview + more,
            ``,
            `To confirm, call memory_forget_imports again with the same args plus confirm: true`,
          ].join("\n"),
        };
      }

      // Execute deletion
      let chunksDeleted = 0;
      let conversationsDeleted = 0;
      const sourceCounts: Record<string, number> = {};
      for (const t of targets) {
        const removed = memory.forgetConversation(t.conversation_id);
        chunksDeleted += removed;
        conversationsDeleted++;
        sourceCounts[t.source_format] = (sourceCounts[t.source_format] || 0) + 1;
      }

      const sourceBreakdown = Object.entries(sourceCounts)
        .map(([s, n]) => `${s}: ${n}`)
        .join(", ");

      return {
        content: [
          `Deleted ${conversationsDeleted} imported conversation(s) and ${chunksDeleted} memory chunk(s).`,
          `By source: ${sourceBreakdown}`,
          ``,
          formatSummary(memory),
        ].join("\n"),
      };
    },
  };
}

interface Target {
  conversation_id: string;
  source_format: string;
  ingested_at: number;
  title: string | null;
}

function collectTargets(memory: MemoryIndex, source?: string, sinceMinutes?: number): Target[] {
  const out: Target[] = [];

  if (sinceMinutes !== undefined) {
    const since = Date.now() - sinceMinutes * 60_000;
    const recent = memory.listImportConversationsSince(since);
    for (const r of recent) {
      if (source && r.source_format !== source) continue;
      out.push(r);
    }
    return out;
  }

  if (source) {
    const ids = memory.listImportConversationsBySource(source);
    // Need full rows to show titles in preview — cheaper to call `since` with epoch 0
    const all = memory.listImportConversationsSince(0);
    const idSet = new Set(ids);
    for (const r of all) {
      if (idSet.has(r.conversation_id)) out.push(r);
    }
    return out;
  }

  return out;
}

function formatSummary(memory: MemoryIndex): string {
  const summary = memory.getIngestSummary();
  if (summary.length === 0) return "No imported memories. (Nothing to forget.)";

  const lines = [`Currently imported (${summary.length} source${summary.length === 1 ? "" : "s"}):`];
  for (const s of summary) {
    const lastAgo = humanAgo(Date.now() - s.lastIngestedAt);
    lines.push(
      `  - ${s.source}: ${s.conversations.toLocaleString()} conversations, ` +
      `${s.messages.toLocaleString()} messages (last ingested ${lastAgo})`
    );
  }
  return lines.join("\n");
}

function humanAgo(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

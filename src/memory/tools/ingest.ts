import type { MemoryIndex } from "../../memory/index.js";
import { resolveAgentPath, sessionIdOf } from "../../workspace/paths.js";

// Conversation ingest tool
export function createIngestTool(memory: MemoryIndex) {
  return {
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
      const raw = dir || file;
      if (!raw) return { content: "Provide either 'directory' or 'file' parameter.", isError: true };
      // Resolved as the file-access gate resolved it (a relative path anchors at
      // the workspace), so the path checked is the path read.
      const target = resolveAgentPath(raw, sessionIdOf(args));
      const onProgress = typeof args._onProgress === "function" ? args._onProgress as (msg: string) => void : undefined;

      try {
        const { ingestConversations } = await import("../../conversation/ingest.js");
        const chunksBefore = memory.countChunks("import/");
        const result = await ingestConversations(memory, target, (p) => {
          const total = p.totalConversations || 1;
          const done = p.processed + p.skipped;
          const pct = Math.round((done / total) * 100);
          onProgress?.(`${pct}%|${done}/${total} conversations, ${p.chunksCreated} chunks|${p.currentFile}`);
        });
        const chunksAfter = memory.countChunks("import/");
        const observed = chunksAfter - chunksBefore;
        if (result.chunksCreated > 0 && observed < result.chunksCreated) {
          return {
            content: `Ingest verification failed: claimed ${result.chunksCreated} chunks, found ${observed} in DB. Some chunks did not persist.`,
            isError: true,
          };
        }
        const fmtList = Object.entries(result.formats).map(([k, v]) => `${k}: ${v}`).join(", ");
        return {
          content: [
            `Ingest complete.`,
            `Conversations: ${result.processed} processed, ${result.skipped} skipped, ${result.errors} errors`,
            `Chunks created: ${result.chunksCreated} (verified: ${observed})`,
            `Formats: ${fmtList || "none"}`,
            `Total in database: ${memory.getIngestStats().total}`,
          ].join("\n"),
        };
      } catch (e) {
        return { content: `Ingest failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

import type { MemoryIndex } from "../../memory.js";
import { discoverMemorySources } from "../discovery/index.js";

// Read-only filesystem scan for memory stores from other agents/tools.
// Returns ranked candidates so the agent can ask the user before importing.
export function createDiscoverTool(_memory: MemoryIndex) {
  return {
    name: "memory_discover",
    description:
      "Scan the user's filesystem for memory stores from other AI agents or tools. " +
      "Walks OS-standard data directories (AppData, ~/Library, ~/.config, Documents, Downloads), " +
      "identifies files that look like conversation exports or memory databases, and returns " +
      "ranked candidates. Read-only — does not import or modify anything. " +
      "Use this when the user asks to import memories from another tool by name. " +
      "Then call memory_ingest with the chosen path to commit.",
    parameters: {
      type: "object",
      properties: {
        roots: {
          type: "array",
          items: { type: "string" },
          description: "Optional explicit directories to scan. Defaults to OS-standard user data locations.",
        },
        maxResults: {
          type: "number",
          description: "Maximum candidates to return in the report (default: 20)",
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const roots = Array.isArray(args.roots) ? (args.roots as string[]).filter(s => typeof s === "string") : undefined;
      const maxResults = typeof args.maxResults === "number" ? args.maxResults : 20;

      try {
        const report = discoverMemorySources(roots ? { roots } : {});
        const top = report.candidates.slice(0, maxResults);

        if (top.length === 0) {
          return {
            content: [
              `No memory stores found.`,
              `Scanned ${report.rootsScanned.length} root(s), inspected ${report.filesInspected} files in ${report.durationMs}ms.`,
              `If you know where the export is, provide a path and call memory_ingest directly.`,
            ].join("\n"),
          };
        }

        const lines = [
          `Found ${report.candidates.length} candidate memory store(s) (showing top ${top.length}).`,
          `Scanned ${report.rootsScanned.length} root(s), inspected ${report.filesInspected} files in ${report.durationMs}ms.`,
          ``,
        ];
        top.forEach((c, i) => {
          const sizeMB = (c.fileSize / (1024 * 1024)).toFixed(1);
          const ageDays = Math.round((Date.now() - c.lastModified) / (1000 * 60 * 60 * 24));
          const ageStr = ageDays === 0 ? "today" : ageDays === 1 ? "yesterday" : `${ageDays}d ago`;
          lines.push(
            `${i + 1}. [${c.format}] ${c.parentApp} — ~${c.estimatedRecords.toLocaleString()} records, ` +
            `${sizeMB}MB, modified ${ageStr} (confidence ${(c.confidence * 100).toFixed(0)}%)`
          );
          lines.push(`   ${c.path}`);
        });
        lines.push(``);
        lines.push(`To import any of these, call memory_ingest with the path. Imports are tagged so they can be removed later.`);

        return { content: lines.join("\n") };
      } catch (e) {
        return { content: `Discovery failed: ${(e as Error).message}`, isError: true };
      }
    },
  };
}

import type { ToolDefinition, ToolResult } from "../../types.js";
import { runCurator } from "./run.js";
import { loadCuratorState } from "./state.js";
import type { RunCuratorOpts } from "./types.js";

export function createCuratorTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_curate",
      description:
        "Run a catalog maintenance pass: apply automatic lifecycle transitions (stale→archived→purged), " +
        "detect protocol clusters that could be consolidated, and surface search misses signaling catalog gaps. " +
        "Writes a markdown report to workspace/protocols/.curator/reports/ and returns its path. " +
        "Pass `skipTransitions: true` to run survey only (no archive moves). Safe to run any time; the auxiliary-model call is throttled and skipped if no provider is configured.",
      parameters: {
        type: "object",
        properties: {
          skipTransitions: { type: "boolean", description: "Skip the lifecycle transitions pass; survey only. Default false." },
          archiveAfterDays: { type: "integer", description: "Stale→archive cutoff in days. Default 90." },
          purgeArchivedAfterDays: { type: "integer", description: "Archive→hard-delete cutoff in days. Default 30." },
        },
      },
      async execute(args): Promise<ToolResult> {
        const opts: RunCuratorOpts = {
          skipTransitions: (args as { skipTransitions?: boolean }).skipTransitions === true,
        };
        const a = Number((args as { archiveAfterDays?: number }).archiveAfterDays);
        if (Number.isFinite(a)) opts.archiveAfterDays = Math.max(30, a);
        const p = Number((args as { purgeArchivedAfterDays?: number }).purgeArchivedAfterDays);
        if (Number.isFinite(p)) opts.purgeArchivedAfterDays = Math.max(7, p);

        try {
          const report = await runCurator(opts);
          const lines = [
            `Curator pass complete.`,
            `Report: ${report.reportPath}`,
            ``,
            `Transitions: archived ${report.transitions.archived.length}, purged ${report.transitions.purged.length}, pinned-skipped ${report.transitions.skippedPinned}.`,
            `Clusters detected: ${report.clusters.length}`,
            `Search misses surveyed: ${report.searchMisses.length}`,
          ];
          if (report.llmJudgments.skipped) lines.push(``, `LLM section skipped: ${report.llmJudgments.skipped}`);
          return { content: lines.join("\n") };
        } catch (e) {
          return { content: `Curator failed: ${(e as Error).message}`, isError: true };
        }
      },
    },
    {
      name: "protocol_curator_status",
      description: "Show when the curator last ran and where its most recent report lives. Use before running protocol_curate to check if a fresh pass is needed.",
      parameters: { type: "object", properties: {} },
      async execute(): Promise<ToolResult> {
        const s = loadCuratorState();
        if (s.runs === 0) return { content: "Curator has never run on this workspace. Call protocol_curate to do a first pass." };
        const daysAgo = Math.floor((Date.now() - s.lastRunTs) / 86_400_000);
        const hoursAgo = Math.floor((Date.now() - s.lastRunTs) / 3_600_000);
        const age = daysAgo > 0 ? `${daysAgo}d ago` : `${hoursAgo}h ago`;
        return {
          content: [
            `Curator runs: ${s.runs}`,
            `Last run: ${new Date(s.lastRunTs).toISOString()} (${age})`,
            `Last report: ${s.lastReportPath}`,
          ].join("\n"),
        };
      },
    },
  ];
}

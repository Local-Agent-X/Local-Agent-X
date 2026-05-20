/**
 * protocol_stats / protocol_prune — surface the telemetry recorded by
 * src/protocols/usage.ts and act on it.
 *
 * The pair closes the loop: telemetry collects, stats reports, prune deletes.
 * Without prune, the catalog grows monotonically and search ranking degrades;
 * without stats, prune is acting blind. Both tools are eager (small, infrequent,
 * but high-value when relevant).
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { getProtocolStats, getSearchMisses, listUnusedProtocols, usageFileSizeBytes } from "./usage.js";
import { getAllProtocols } from "../protocols.js";
import { deleteProtocol } from "./builder.js";

export function createProtocolStatsTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_stats",
      description:
        "Show protocol usage telemetry: most-invoked protocols, never-used protocols, and recent search queries that returned no hits (signals for new protocols to build). " +
        "Pass `verbose: true` to include per-protocol invocation timestamps. " +
        "Call this before protocol_prune to see what's safe to delete.",
      parameters: {
        type: "object",
        properties: {
          verbose: { type: "boolean", description: "Include per-protocol last-invocation date. Default false." },
          topN: { type: "integer", description: "Top N most-used protocols to show. Default 10, cap 50." },
        },
      },
      async execute(args): Promise<ToolResult> {
        const verbose = Boolean((args as { verbose?: boolean }).verbose);
        const topN = Math.max(1, Math.min(50, Number((args as { topN?: number }).topN) || 10));

        const stats = getProtocolStats();
        const allNames = getAllProtocols().map((p) => p.name);
        const unused = listUnusedProtocols(allNames, 0).filter((u) => u.reason === "never");
        const misses = getSearchMisses(10);
        const sizeBytes = usageFileSizeBytes();

        const lines: string[] = [];
        lines.push(`# Protocol Usage`);
        lines.push(``);
        lines.push(`Total protocols in catalog: ${allNames.length}`);
        lines.push(`Protocols ever invoked: ${stats.length}`);
        lines.push(`Protocols never invoked: ${unused.length}`);
        lines.push(`Telemetry file: ${sizeBytes} bytes`);
        lines.push(``);

        if (stats.length > 0) {
          lines.push(`## Top ${Math.min(topN, stats.length)} most-invoked`);
          for (const s of stats.slice(0, topN)) {
            const days = s.lastInvokedDaysAgo === null ? "never" : `${s.lastInvokedDaysAgo}d ago`;
            lines.push(verbose
              ? `- ${s.name}: ${s.invocations} invocation(s), last ${days}`
              : `- ${s.name}: ${s.invocations}`);
          }
          lines.push(``);
        }

        if (unused.length > 0) {
          lines.push(`## Never invoked (${unused.length})`);
          lines.push(unused.map((u) => `- ${u.name}`).join("\n"));
          lines.push(``);
          lines.push(`Run \`protocol_prune({olderThanDays: 30})\` to delete protocols not invoked in 30+ days.`);
          lines.push(``);
        }

        if (misses.length > 0) {
          lines.push(`## Recent search misses (queries that returned nothing)`);
          lines.push(`These are signals for new protocols to build.`);
          for (const m of misses) {
            lines.push(`- "${m.query}" (${m.count}× last ${Math.floor((Date.now() - m.lastTs) / 86_400_000)}d ago)`);
          }
          lines.push(``);
        }

        return { content: lines.join("\n").trim() };
      },
    },
    {
      name: "protocol_prune",
      description:
        "Delete user protocols (source=custom) that haven't been invoked in N days. " +
        "Never deletes built-in or bundled protocols — only ones the user (or agent) created via protocol_create / protocol_build. " +
        "Pass `dryRun: true` first to preview what would be deleted.",
      parameters: {
        type: "object",
        properties: {
          olderThanDays: { type: "integer", description: "Delete custom protocols not invoked in this many days. Default 30. Minimum 7." },
          dryRun: { type: "boolean", description: "If true, only list candidates without deleting. Default true (safe). Pass false to actually delete." },
        },
      },
      async execute(args): Promise<ToolResult> {
        const olderThanDays = Math.max(7, Number((args as { olderThanDays?: number }).olderThanDays) || 30);
        // Default to dry-run so the model can't accidentally nuke the catalog
        // on an underspecified call. Caller must explicitly pass false to act.
        const rawDryRun = (args as { dryRun?: boolean }).dryRun;
        const dryRun = rawDryRun === false ? false : true;

        // Only prune CUSTOM-sourced protocols. Built-in and bundled ship with
        // the install and aren't ours to delete; imported SKILL.md packs are
        // user-added files — let them clean those up directly.
        const all = getAllProtocols();
        const customNames = all
          .filter((p) => p.source?.type === "custom")
          .map((p) => p.name);
        if (customNames.length === 0) {
          return { content: "No custom protocols to prune. (Built-in and bundled protocols are never auto-pruned.)" };
        }

        const candidates = listUnusedProtocols(customNames, olderThanDays);
        if (candidates.length === 0) {
          return { content: `No custom protocols match the pruning criteria (unused for ${olderThanDays}+ days).` };
        }

        if (dryRun) {
          const list = candidates.map((c) => {
            const why = c.reason === "never" ? "never invoked" : `last ${c.daysAgo}d ago`;
            return `- ${c.name} (${why})`;
          }).join("\n");
          return {
            content: `${candidates.length} custom protocol(s) eligible for pruning (dry-run):\n${list}\n\nRe-call with \`dryRun: false\` to actually delete.`,
          };
        }

        let deleted = 0;
        const failed: string[] = [];
        for (const c of candidates) {
          try {
            if (deleteProtocol(c.name)) deleted += 1;
          } catch (e) {
            failed.push(`${c.name}: ${(e as Error).message}`);
          }
        }
        const out = [`Pruned ${deleted}/${candidates.length} custom protocol(s).`];
        if (failed.length > 0) out.push(`Failed: ${failed.join("; ")}`);
        return { content: out.join("\n") };
      },
    },
  ];
}

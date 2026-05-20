/**
 * protocol_stats / protocol_prune — surface the telemetry recorded by
 * src/protocols/usage.ts and act on it.
 *
 * The pair closes the loop: telemetry collects, stats reports, prune transitions.
 * Without prune, the catalog grows monotonically and search ranking degrades;
 * without stats, prune is acting blind.
 *
 * Lifecycle states (computed, not stored):
 *   active   — invoked within stale-cutoff (default 30d)
 *   stale    — never invoked, OR last invoked > 30d ago
 *   archived — in workspace/protocols/archived.json (soft-deleted, recoverable)
 *
 * protocol_prune now does the staged transition:
 *   active/stale → archived (after archiveAfter days)
 *   archived     → hard-deleted (after purgeArchivedAfter days in archive)
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { getProtocolStats, getSearchMisses, listUnusedProtocols, usageFileSizeBytes } from "./usage.js";
import { getAllProtocols } from "../protocols.js";
import {
  loadArchived, archiveProtocol, applyAutomaticTransitions, computeProtocolState,
  type ProtocolState,
} from "./archive.js";

export function createProtocolStatsTools(): ToolDefinition[] {
  return [
    {
      name: "protocol_stats",
      description:
        "Show protocol usage telemetry: lifecycle states, most-invoked protocols, never-used protocols, " +
        "archived count, and recent search queries that returned no hits (signals for new protocols to build). " +
        "Pass `verbose: true` to include per-protocol invocation timestamps. " +
        "Call this before protocol_prune to see what's safe to archive.",
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

        const all = getAllProtocols();
        const stats = getProtocolStats();
        const allNames = all.map((p) => p.name);
        const unused = listUnusedProtocols(allNames, 0).filter((u) => u.reason === "never");
        const misses = getSearchMisses(10);
        const sizeBytes = usageFileSizeBytes();
        const archived = loadArchived();

        // ── Lifecycle state distribution (custom only — built-ins don't decay) ──
        const archivedNames = new Set(archived.map((r) => r.protocol.name));
        const statByName = new Map(stats.map((s) => [s.name, s]));
        const customNames = all.filter((p) => p.source?.type === "custom").map((p) => p.name);
        const stateCounts: Record<ProtocolState, number> = { active: 0, stale: 0, archived: 0 };
        for (const name of customNames) {
          const s = statByName.get(name);
          const state = computeProtocolState(name, {
            archivedNames,
            lastInvokedDaysAgo: s?.lastInvokedDaysAgo ?? null,
          });
          stateCounts[state] += 1;
        }
        // Archived count includes ALL archived records, not just those matching
        // current custom names (an archive entry persists even if its slot in
        // custom.json was reused for something else).
        stateCounts.archived = archived.length;

        const pinned = all.filter((p) => p.pinned).length;

        const lines: string[] = [];
        lines.push(`# Protocol Usage`);
        lines.push(``);
        lines.push(`Total protocols in catalog: ${allNames.length}`);
        lines.push(`Custom protocols: ${customNames.length} (active ${stateCounts.active}, stale ${stateCounts.stale}, pinned ${pinned})`);
        lines.push(`Archived: ${stateCounts.archived}`);
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
          lines.push(`Run \`protocol_prune({olderThanDays: 30})\` to archive stale custom protocols.`);
          lines.push(``);
        }

        if (archived.length > 0) {
          lines.push(`## Archived (${archived.length})`);
          for (const r of archived.slice(0, 10)) {
            const daysAgo = Math.floor((Date.now() - r.archivedTs) / 86_400_000);
            const why = r.reason ? ` — ${r.reason}` : "";
            lines.push(`- ${r.protocol.name} (${daysAgo}d ago)${why}`);
          }
          if (archived.length > 10) lines.push(`  ...and ${archived.length - 10} more`);
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
        "Apply lifecycle transitions to custom protocols: archive stale (default 90d unused, unpinned) and " +
        "hard-delete archive entries older than `purgeArchivedAfterDays` (default 30d). " +
        "Never touches built-in or bundled protocols. Pinned protocols are skipped. " +
        "Pass `dryRun: true` first to preview what would change.",
      parameters: {
        type: "object",
        properties: {
          archiveAfterDays: { type: "integer", description: "Archive custom protocols not invoked in this many days. Default 90. Minimum 30." },
          purgeArchivedAfterDays: { type: "integer", description: "Hard-delete archived entries this many days old. Default 30. Minimum 7." },
          dryRun: { type: "boolean", description: "If true, only list candidates without acting. Default true (safe). Pass false to apply." },
        },
      },
      async execute(args): Promise<ToolResult> {
        const archiveAfterDays = Math.max(30, Number((args as { archiveAfterDays?: number }).archiveAfterDays) || 90);
        const purgeArchivedAfterDays = Math.max(7, Number((args as { purgeArchivedAfterDays?: number }).purgeArchivedAfterDays) || 30);
        // Default to dry-run so the model can't accidentally nuke the catalog
        // on an underspecified call. Caller must explicitly pass false to act.
        const rawDryRun = (args as { dryRun?: boolean }).dryRun;
        const dryRun = rawDryRun === false ? false : true;

        if (dryRun) {
          // Preview only — read state, compute would-be transitions, don't write.
          const all = getAllProtocols();
          const stats = new Map(getProtocolStats().map((s) => [s.name, s]));
          const archive = loadArchived();
          const now = Date.now();

          const toArchive: Array<{ name: string; reason: string }> = [];
          for (const p of all) {
            if (p.source?.type !== "custom") continue;
            if (p.pinned) continue;
            const s = stats.get(p.name);
            const daysAgo = s?.lastInvokedDaysAgo ?? null;
            if (daysAgo !== null && daysAgo >= archiveAfterDays) {
              toArchive.push({ name: p.name, reason: `not invoked in ${daysAgo}d` });
            }
          }
          const toPurge: Array<{ name: string; daysSinceArchive: number }> = [];
          for (const r of archive) {
            const d = Math.floor((now - r.archivedTs) / 86_400_000);
            if (d >= purgeArchivedAfterDays) toPurge.push({ name: r.protocol.name, daysSinceArchive: d });
          }

          if (toArchive.length === 0 && toPurge.length === 0) {
            return { content: `Nothing to prune. (archive cutoff ${archiveAfterDays}d, purge cutoff ${purgeArchivedAfterDays}d)` };
          }
          const out: string[] = [];
          if (toArchive.length > 0) {
            out.push(`Would archive ${toArchive.length} custom protocol(s):`);
            for (const a of toArchive) out.push(`  - ${a.name} (${a.reason})`);
          }
          if (toPurge.length > 0) {
            out.push(`Would hard-delete ${toPurge.length} archived entry(s):`);
            for (const p of toPurge) out.push(`  - ${p.name} (archived ${p.daysSinceArchive}d ago)`);
          }
          out.push(``, `Re-call with \`dryRun: false\` to apply.`);
          return { content: out.join("\n") };
        }

        // Apply: use the canonical transition function so behavior matches the
        // scheduled curator pass exactly.
        const report = applyAutomaticTransitions({
          archiveAfterDays,
          purgeArchivedAfterDays,
        });

        const lines = [
          `Pruned: archived ${report.archived.length}, hard-deleted ${report.purged.length}.`,
        ];
        if (report.skippedPinned > 0) lines.push(`Skipped ${report.skippedPinned} pinned protocol(s).`);
        if (report.archived.length > 0) {
          lines.push(``, `Archived:`);
          for (const a of report.archived) lines.push(`  - ${a.name} — ${a.reason}`);
        }
        if (report.purged.length > 0) {
          lines.push(``, `Hard-deleted (after ${purgeArchivedAfterDays}d in archive):`);
          for (const p of report.purged) lines.push(`  - ${p.name}`);
        }
        return { content: lines.join("\n") };
      },
    },
    {
      name: "protocol_archive_bulk",
      description:
        "Archive a list of custom protocols in one call. Useful when acting on a curator report. " +
        "Skips pinned protocols and built-in/bundled (which can't be archived). " +
        "Returns a per-name result list.",
      parameters: {
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" }, description: "Protocol names to archive" },
          reason: { type: "string", description: "Reason recorded with each archive entry" },
        },
        required: ["names"],
      },
      async execute(args): Promise<ToolResult> {
        const names = (args.names as string[]) || [];
        const reason = typeof (args as { reason?: string }).reason === "string" ? (args as { reason?: string }).reason : undefined;
        if (names.length === 0) return { content: "names array is empty", isError: true };

        const all = getAllProtocols();
        const byName = new Map(all.map((p) => [p.name, p]));
        const archived: string[] = [];
        const skipped: string[] = [];
        for (const name of names) {
          const p = byName.get(name);
          if (!p) { skipped.push(`${name}: not found`); continue; }
          if (p.source?.type !== "custom") { skipped.push(`${name}: not custom (${p.source?.type})`); continue; }
          if (p.pinned) { skipped.push(`${name}: pinned`); continue; }
          const rec = archiveProtocol(name, reason);
          if (rec) archived.push(name);
          else skipped.push(`${name}: already archived or not in live catalog`);
        }
        const out = [`Archived ${archived.length}/${names.length}.`];
        if (archived.length > 0) out.push(`Archived: ${archived.join(", ")}`);
        if (skipped.length > 0) out.push(`Skipped:\n  ${skipped.join("\n  ")}`);
        return { content: out.join("\n") };
      },
    },
  ];
}

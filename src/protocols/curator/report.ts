import type { TransitionReport } from "../archive.js";
import type { Cluster, LLMJudgment } from "./types.js";

export interface RenderReportInput {
  ts: number;
  customNames: string[];
  archivedCount: number;
  transitions: TransitionReport;
  clusters: Cluster[];
  judgments: LLMJudgment;
  searchMisses: Array<{ query: string; count: number; daysAgo: number }>;
  missesSurveyed: number;
}

export function renderReport(input: RenderReportInput): string {
  const { ts, customNames, archivedCount, transitions, clusters, judgments, searchMisses, missesSurveyed } = input;
  const lines: string[] = [];
  const date = new Date(ts).toISOString();
  lines.push(`# Protocol Curator Report — ${date}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- Custom protocols: ${customNames.length}`);
  lines.push(`- Archived: ${archivedCount}`);
  lines.push(`- Clusters detected: ${clusters.length}`);
  lines.push(`- Search misses surveyed: ${missesSurveyed}`);
  lines.push(``);

  lines.push(`## Lifecycle transitions`);
  if (transitions.archived.length === 0 && transitions.purged.length === 0) {
    lines.push(`No transitions in this pass.`);
  } else {
    if (transitions.archived.length > 0) {
      lines.push(`### Archived (stale → archived)`);
      for (const a of transitions.archived) lines.push(`- ${a.name} — ${a.reason}`);
    }
    if (transitions.purged.length > 0) {
      lines.push(``, `### Purged (archived → hard-deleted)`);
      for (const p of transitions.purged) lines.push(`- ${p.name} (in archive ${p.daysSinceArchive}d)`);
    }
  }
  lines.push(``);

  if (clusters.length > 0) {
    lines.push(`## Embedding clusters (raw)`);
    for (const c of clusters) {
      lines.push(`- cohesion ${c.cohesion.toFixed(2)}: ${c.members.join(", ")}`);
    }
    lines.push(``);
  }

  lines.push(`## Consolidation candidates`);
  lines.push(judgments.consolidations);
  lines.push(``);
  lines.push(`## Catalog gaps`);
  lines.push(judgments.catalogGaps);
  lines.push(``);

  if (judgments.skipped) {
    lines.push(`> Note: ${judgments.skipped}`);
    lines.push(``);
  }

  if (searchMisses.length > 0) {
    lines.push(`## Search misses (raw, last 20)`);
    for (const m of searchMisses) {
      lines.push(`- "${m.query}" (${m.count}× last ${m.daysAgo}d ago)`);
    }
  }

  return lines.join("\n");
}

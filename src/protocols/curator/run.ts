import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import { getAllProtocols } from "../../protocols.js";
import { applyAutomaticTransitions, loadArchived } from "../archive.js";
import { getSearchMisses } from "../usage.js";
import { findClusters, loadEmbeddingCache } from "./clusters.js";
import { askAuxiliaryModel } from "./llm-judgment.js";
import { renderReport } from "./report.js";
import { curatorDir, loadCuratorState, saveCuratorState } from "./state.js";
import type { CuratorReport, RunCuratorOpts } from "./types.js";

const logger = createLogger("protocols.curator");

export async function runCurator(opts: RunCuratorOpts = {}): Promise<CuratorReport> {
  const ts = Date.now();
  logger.info(`[curator] starting pass`);

  const transitions = opts.skipTransitions
    ? { archived: [], purged: [], scanned: 0, skippedPinned: 0 }
    : applyAutomaticTransitions({
        archiveAfterDays: opts.archiveAfterDays,
        purgeArchivedAfterDays: opts.purgeArchivedAfterDays,
      });

  // Catalog snapshot AFTER transitions — clustering on the live state.
  const all = getAllProtocols();
  const customNames = all.filter((p) => p.source?.type === "custom").map((p) => p.name);
  const cache = loadEmbeddingCache();
  const clusters = findClusters(customNames, cache, opts.clusterThreshold ?? 0.78);

  const protocolsByName: Record<string, { name: string; description: string; triggers: string[] }> = {};
  for (const p of all) {
    if (p.source?.type !== "custom") continue;
    protocolsByName[p.name] = { name: p.name, description: p.description, triggers: p.triggers || [] };
  }

  const misses = getSearchMisses(20);
  const archivedCount = loadArchived().length;
  const judgments = await askAuxiliaryModel({
    clusters,
    protocolsByName,
    searchMisses: misses.map((m) => ({ query: m.query, count: m.count })),
  });

  const searchMisses = misses.map((m) => ({
    query: m.query,
    count: m.count,
    daysAgo: Math.floor((Date.now() - m.lastTs) / 86_400_000),
  }));

  const reportBody = renderReport({
    ts,
    customNames,
    archivedCount,
    transitions,
    clusters,
    judgments,
    searchMisses,
    missesSurveyed: misses.length,
  });

  const tsSlug = new Date(ts).toISOString().replace(/[:.]/g, "-");
  const reportPath = join(curatorDir(), "reports", `${tsSlug}.md`);
  writeFileSync(reportPath, reportBody, "utf-8");

  const prevState = loadCuratorState();
  saveCuratorState({
    lastRunTs: ts,
    lastReportPath: reportPath,
    runs: prevState.runs + 1,
  });

  logger.info(`[curator] pass complete — report at ${reportPath}`);
  return {
    ts,
    transitions,
    clusters,
    searchMisses,
    llmJudgments: judgments,
    reportPath,
  };
}

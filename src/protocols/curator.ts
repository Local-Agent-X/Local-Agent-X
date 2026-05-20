/**
 * Protocol curator — periodic catalog maintenance pass.
 *
 * What it does (in order):
 *   1. Run automatic lifecycle transitions (stale→archived, archived→purged).
 *   2. Survey the catalog: pull per-protocol stats, search misses, embedding
 *      clusters of likely-redundant protocols.
 *   3. Ask a cheap auxiliary model (Haiku by default, falls back to whatever
 *      llm-dispatch picks) for two judgments:
 *        - which clusters could be consolidated into a single umbrella, and
 *        - which search misses signal genuine catalog gaps worth a new protocol.
 *   4. Write a structured report to workspace/protocols/.curator/reports/<ts>.md
 *      and update workspace/protocols/.curator/state.json with the run timestamp.
 *
 * Dry-run by default. The curator never modifies the catalog beyond the
 * lifecycle transitions in step 1 — consolidation/new-protocol suggestions are
 * advisory, surfaced for the agent/user to act on via protocol_create /
 * protocol_archive_bulk on a later turn.
 *
 * Soft dependencies:
 *   - llm-dispatch (auxiliary-model call) — if no provider is available, the
 *     LLM-judgment section is skipped and the report still ships with the
 *     mechanical sections (transitions + raw signals).
 *   - embedding provider — drives cluster detection. If absent, clusters
 *     section is skipped; transitions still run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../config.js";
import { dispatch } from "../llm-dispatch.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { getAllProtocols } from "../protocols.js";
import { getSearchMisses } from "./usage.js";
import { applyAutomaticTransitions, loadArchived, type TransitionReport } from "./archive.js";
import { createLogger } from "../logger.js";

const logger = createLogger("protocols.curator");

interface CuratorState {
  lastRunTs: number;
  lastReportPath: string;
  runs: number;
}

interface Cluster {
  members: string[];
  /** Highest pairwise similarity inside the cluster (sanity check). */
  cohesion: number;
}

export interface CuratorReport {
  ts: number;
  transitions: TransitionReport;
  clusters: Cluster[];
  searchMisses: Array<{ query: string; count: number; daysAgo: number }>;
  llmJudgments: {
    consolidations: string;
    catalogGaps: string;
    skipped?: string;
  };
  reportPath: string;
}

function curatorDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols", ".curator");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const reports = join(dir, "reports");
  if (!existsSync(reports)) mkdirSync(reports, { recursive: true });
  return dir;
}

function statePath(): string {
  return join(curatorDir(), "state.json");
}

export function loadCuratorState(): CuratorState {
  const p = statePath();
  if (!existsSync(p)) return { lastRunTs: 0, lastReportPath: "", runs: 0 };
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return { lastRunTs: 0, lastReportPath: "", runs: 0 }; }
}

function saveCuratorState(s: CuratorState): void {
  writeFileSync(statePath(), JSON.stringify(s, null, 2), "utf-8");
}

/** Throttle for the scheduled background pass: skip if a run completed within
 *  the last `minIntervalHours` AND the catalog hasn't grown since. */
export function shouldCurate(opts: { minIntervalHours?: number; minCustomProtocols?: number } = {}): boolean {
  const minInterval = (opts.minIntervalHours ?? 18) * 3_600_000;
  const minCustom = opts.minCustomProtocols ?? 5;
  const customCount = getAllProtocols().filter((p) => p.source?.type === "custom").length;
  if (customCount < minCustom) return false;
  const state = loadCuratorState();
  if (Date.now() - state.lastRunTs < minInterval) return false;
  return true;
}

// ── Cluster detection via embeddings cache ───────────────────────────────────
//
// Hits the same embeddings.json file dedup.ts writes. We don't re-embed here:
// if the cache doesn't have an entry for a protocol, we skip it. The dedup
// pass on protocol_create populates the cache incrementally; the curator is
// the consumer.

interface EmbeddingCacheEntry { vec: number[]; textHash: string }
type EmbeddingCache = Record<string, EmbeddingCacheEntry>;

function loadEmbeddingCache(): EmbeddingCache {
  const cfg = getRuntimeConfig();
  const p = join(resolve(cfg.workspace, "protocols"), "embeddings.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Union-find cluster of protocol names whose pairwise cosine ≥ threshold.
 *  Threshold is intentionally below the write-time dedup threshold (0.85) —
 *  we're looking for "could be consolidated", not "exact duplicates". */
function findClusters(names: string[], cache: EmbeddingCache, threshold = 0.78): Cluster[] {
  const present = names.filter((n) => Array.isArray(cache[n]?.vec));
  const parent = new Map<string, string>();
  const maxSim = new Map<string, number>();
  for (const n of present) { parent.set(n, n); maxSim.set(n, 0); }

  const find = (x: string): string => {
    let p = parent.get(x)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(x, p);
    return p;
  };

  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i], b = present[j];
      const sim = cosine(cache[a].vec, cache[b].vec);
      if (sim >= threshold) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
        if (sim > (maxSim.get(a) || 0)) maxSim.set(a, sim);
        if (sim > (maxSim.get(b) || 0)) maxSim.set(b, sim);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const n of present) {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(n);
  }
  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const cohesion = Math.max(...members.map((m) => maxSim.get(m) || 0));
    clusters.push({ members: members.sort(), cohesion });
  }
  return clusters.sort((a, b) => b.cohesion - a.cohesion);
}

// ── LLM judgment ────────────────────────────────────────────────────────────

interface LLMInput {
  clusters: Cluster[];
  protocolsByName: Record<string, { name: string; description: string; triggers: string[] }>;
  searchMisses: Array<{ query: string; count: number }>;
}

async function askAuxiliaryModel(input: LLMInput): Promise<{ consolidations: string; catalogGaps: string; skipped?: string }> {
  // Skip the LLM call when there's nothing to evaluate — the report still
  // ships with the mechanical sections.
  if (input.clusters.length === 0 && input.searchMisses.length === 0) {
    return { consolidations: "(no clusters detected)", catalogGaps: "(no recent search misses)" };
  }

  const sections: string[] = [];

  if (input.clusters.length > 0) {
    sections.push("# Candidate clusters (high embedding similarity, may be redundant)");
    for (const c of input.clusters) {
      sections.push(`\n## Cluster (cohesion ${c.cohesion.toFixed(2)})`);
      for (const name of c.members) {
        const p = input.protocolsByName[name];
        if (!p) continue;
        sections.push(`- **${p.name}** — ${p.description} [triggers: ${p.triggers.slice(0, 3).join(", ")}]`);
      }
    }
  }

  if (input.searchMisses.length > 0) {
    sections.push(`\n# Recent search misses (queries that returned no hits)`);
    for (const m of input.searchMisses.slice(0, 15)) {
      sections.push(`- "${m.query}" (${m.count}×)`);
    }
  }

  const prompt = `You are a protocol-catalog curator. Output ONLY two markdown sections — no preamble, no closing remarks.

Below is the current state of a protocol catalog (a library of reusable agent workflows). Your job is to flag (a) clusters that could be consolidated into a single umbrella protocol, and (b) search queries that suggest the catalog is missing a useful protocol.

INPUT:
${sections.join("\n")}

OUTPUT FORMAT — exactly these two sections, no others:

## Consolidation candidates
For each cluster, one bullet: \`- Merge [A, B, C] → propose name "X"; keep the distinct rules from each as separate steps.\` Skip clusters where the members serve genuinely different purposes despite similar wording — flag those as \`- KEEP SEPARATE: [A, B] — reason: ...\`.

## Catalog gaps
For each cluster of related misses, one bullet: \`- Build a protocol for: "...task description...". Triggers: [phrase1, phrase2]. Rationale: appeared X times.\` Only include misses that look like a real recurring need, not one-off odd queries.

Be terse. Be concrete. No filler.`;

  const out = await dispatch({
    prompt,
    provider: "auto",
    preferEnvKeys: true,
    rejectOAuth: false,
    temperature: 0,
    maxTokens: 800,
    timeoutMs: 30_000,
  });

  if (!out) {
    return {
      consolidations: "(LLM unavailable — see raw clusters above for manual review)",
      catalogGaps: "(LLM unavailable — see raw search misses above for manual review)",
      skipped: "no provider responded; report contains mechanical sections only",
    };
  }

  // Split on the two known headings. Fall back to "everything to consolidations"
  // if the model didn't follow the schema.
  const consolidationsMatch = out.match(/##\s*Consolidation candidates\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  const gapsMatch = out.match(/##\s*Catalog gaps\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  return {
    consolidations: consolidationsMatch?.[1].trim() || out.trim(),
    catalogGaps: gapsMatch?.[1].trim() || "(no section emitted)",
  };
}

// ── Top-level run ───────────────────────────────────────────────────────────

export interface RunCuratorOpts {
  /** Skip lifecycle transitions (dry-mode for transitions only). Default false. */
  skipTransitions?: boolean;
  /** Override the stale→archive cutoff. Default 90 days. */
  archiveAfterDays?: number;
  /** Override the archive→purge cutoff. Default 30 days. */
  purgeArchivedAfterDays?: number;
  /** Min cosine similarity for cluster detection. Default 0.78. */
  clusterThreshold?: number;
}

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

  // ── Render report ──
  const lines: string[] = [];
  const date = new Date(ts).toISOString();
  lines.push(`# Protocol Curator Report — ${date}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- Custom protocols: ${customNames.length}`);
  lines.push(`- Archived: ${archivedCount}`);
  lines.push(`- Clusters detected: ${clusters.length}`);
  lines.push(`- Search misses surveyed: ${misses.length}`);
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

  const tsSlug = new Date(ts).toISOString().replace(/[:.]/g, "-");
  const reportPath = join(curatorDir(), "reports", `${tsSlug}.md`);
  writeFileSync(reportPath, lines.join("\n"), "utf-8");

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

// ── Tools ───────────────────────────────────────────────────────────────────

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

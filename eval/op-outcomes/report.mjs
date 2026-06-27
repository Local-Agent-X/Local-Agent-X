#!/usr/bin/env node
/**
 * Outcome-report aggregator — the READ side of telemetry the harness already
 * WRITES but nothing reads for reporting.
 *
 * Two write-only sinks feed this:
 *   - op-outcomes.json  (src/tool-tracker.ts) — per `${category}::${model}`
 *     task-outcome counts: { total, clean, partial, aborted, gaveUpNudged? }.
 *   - canonical-loop-soak-<host>.jsonl  (src/canonical-loop/soak-metrics.ts) —
 *     one row per terminated op with provider/duration/cost/tool/failure fields.
 *
 * From those it derives headline metrics: per-category completion / give-up /
 * partial / aborted rates (completion section), plus per-provider efficiency
 * (avg rounds, avg distinct-tools/op, avg cost, recovery rate, duration
 * percentiles, failure breakdown).
 *
 * Pure functions (computeOutcomeReport, renderMarkdown) do no I/O — the CLI
 * tail reads the files and prints. Mirrors eval/op-outcomes/run.mjs conventions
 * (plain ESM, JSON/JSONL file reads, LAX_DATA_DIR resolution, tolerant parsing).
 *
 * Run:  node eval/op-outcomes/report.mjs
 *       node eval/op-outcomes/report.mjs --soak-dir workspace --json
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ── Pure aggregation ──

function rate(n, total) {
  // 0-total groups have no defined rate; null (not 0) keeps "no data" honest
  // and distinct from a real 0% rate.
  return total > 0 ? n / total : null;
}

function round(x) {
  return x === null ? null : Math.round(x * 1000) / 1000;
}

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  // Nearest-rank on the already-sorted array; cheap and deterministic.
  const idx = Math.min(sortedNums.length - 1, Math.ceil((p / 100) * sortedNums.length) - 1);
  return sortedNums[Math.max(0, idx)];
}

function mean(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * @param {object[]} soakRows  parsed canonical-loop-soak JSONL rows
 * @param {object} opOutcomes  parsed op-outcomes.json (`category::model` → counts)
 */
export function computeOutcomeReport(soakRows, opOutcomes) {
  return {
    completion: computeCompletion(opOutcomes || {}),
    efficiency: computeEfficiency(Array.isArray(soakRows) ? soakRows : []),
  };
}

function computeCompletion(opOutcomes) {
  // Group by category while keeping the per-model breakdown. The key is
  // `${category}::${model}` (tool-tracker.ts), so split on the LAST "::" pair
  // is unnecessary — category never contains "::", so a plain split is safe.
  const byCategory = {};
  for (const [key, c] of Object.entries(opOutcomes)) {
    if (!c || typeof c !== "object") continue;
    const sep = key.indexOf("::");
    const category = sep >= 0 ? key.slice(0, sep) : key;
    const model = sep >= 0 ? key.slice(sep + 2) : "unknown";
    const total = c.total || 0;
    const clean = c.clean || 0;
    const partial = c.partial || 0;
    const aborted = c.aborted || 0;
    const gaveUpNudged = c.gaveUpNudged || 0;

    const group = (byCategory[category] ??= {
      total: 0, clean: 0, partial: 0, aborted: 0, gaveUpNudged: 0, models: {},
    });
    group.total += total;
    group.clean += clean;
    group.partial += partial;
    group.aborted += aborted;
    group.gaveUpNudged += gaveUpNudged;
    group.models[model] = ratesFor({ total, clean, partial, aborted, gaveUpNudged });
  }

  const out = {};
  for (const [category, g] of Object.entries(byCategory)) {
    out[category] = { ...ratesFor(g), models: g.models };
  }
  return out;
}

function ratesFor({ total, clean, partial, aborted, gaveUpNudged }) {
  return {
    total,
    completionRate: round(rate(clean, total)),
    partialRate: round(rate(partial, total)),
    abortedRate: round(rate(aborted, total)),
    // gaveUpNudged is counted DURING the op (not at terminal) so it does NOT
    // bump `total` (tool-tracker.ts) — rate-over-total can therefore exceed
    // partial+aborted+clean, which is expected, not a bug.
    giveUpRate: round(rate(gaveUpNudged, total)),
  };
}

function computeEfficiency(soakRows) {
  const all = effFor(soakRows);
  const byProvider = {};
  const providers = new Set(soakRows.map((r) => r.provider ?? "unknown"));
  for (const p of providers) {
    byProvider[p] = effFor(soakRows.filter((r) => (r.provider ?? "unknown") === p));
  }
  return { all, byProvider };
}

function effFor(rows) {
  const durations = rows
    .map((r) => r.durationMs)
    .filter((d) => typeof d === "number")
    .sort((a, b) => a - b);
  const costs = rows.map((r) => r.estimatedCostUsd).filter((c) => typeof c === "number");
  const roundsArr = rows.map((r) => r.rounds).filter((n) => typeof n === "number");
  // soak `toolsCalled` is a sorted, DEDUPED set of names (or null) — so this is
  // distinct-tools/op, NOT raw tool-call count. Labeled honestly downstream.
  const distinctTools = rows.map((r) => (Array.isArray(r.toolsCalled) ? r.toolsCalled.length : 0));
  const recovered = rows.filter((r) => r.crashRecovered === true).length;

  const failureBreakdown = {};
  for (const r of rows) {
    if (r.terminal === "succeeded") continue;
    const fc = r.failureClass || "unknown";
    failureBreakdown[fc] = (failureBreakdown[fc] || 0) + 1;
  }

  return {
    ops: rows.length,
    avgRounds: round(mean(roundsArr)),
    avgDistinctTools: round(mean(distinctTools)),
    avgCostUsd: round(mean(costs)),
    recoveryRate: round(rate(recovered, rows.length)),
    p50DurationMs: percentile(durations, 50),
    p90DurationMs: percentile(durations, 90),
    failureBreakdown,
  };
}

// ── Markdown rendering ──

function fmtRate(r) {
  return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
}
function fmtNum(n) {
  return n === null || n === undefined ? "—" : String(n);
}
function fmtCost(c) {
  return c === null || c === undefined ? "—" : `$${c.toFixed(6)}`;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("## Outcome report");
  lines.push("");

  // Completion table (category rows).
  lines.push("### Completion (by category)");
  const catEntries = Object.entries(report.completion || {});
  if (catEntries.length === 0) {
    lines.push("");
    lines.push("_no completion data_");
  } else {
    lines.push("");
    lines.push("| category | total | completion | partial | aborted | give-up |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [cat, g] of catEntries) {
      lines.push(
        `| ${cat} | ${fmtNum(g.total)} | ${fmtRate(g.completionRate)} | ` +
          `${fmtRate(g.partialRate)} | ${fmtRate(g.abortedRate)} | ${fmtRate(g.giveUpRate)} |`,
      );
    }
  }
  lines.push("");

  // Efficiency table (provider rows + "all").
  lines.push("### Efficiency (by provider)");
  const eff = report.efficiency || { all: null, byProvider: {} };
  const provEntries = Object.entries(eff.byProvider || {});
  if ((eff.all?.ops ?? 0) === 0 && provEntries.length === 0) {
    lines.push("");
    lines.push("_no efficiency data_");
  } else {
    lines.push("");
    lines.push("| provider | ops | avg rounds | distinct tools/op | avg cost | recovery | p50 ms | p90 ms |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const row = (label, e) =>
      `| ${label} | ${fmtNum(e.ops)} | ${fmtNum(e.avgRounds)} | ${fmtNum(e.avgDistinctTools)} | ` +
      `${fmtCost(e.avgCostUsd)} | ${fmtRate(e.recoveryRate)} | ${fmtNum(e.p50DurationMs)} | ${fmtNum(e.p90DurationMs)} |`;
    for (const [prov, e] of provEntries) lines.push(row(prov, e));
    if (eff.all) lines.push(row("**all**", eff.all));

    // Failure breakdown (overall) — only when there are non-succeeded ops.
    const fb = Object.entries(eff.all?.failureBreakdown || {});
    if (fb.length > 0) {
      lines.push("");
      lines.push("**Failures (all providers):** " + fb.map(([k, v]) => `${k}=${v}`).join(", "));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ── CLI tail ──

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines (partial last line, mid-write tears) — never crash.
    }
  }
  return rows;
}

export function readSoakDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir).filter(
      (f) => f.startsWith("canonical-loop-soak-") && f.endsWith(".jsonl"),
    );
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    try {
      rows.push(...parseJsonl(readFileSync(join(dir, f), "utf-8")));
    } catch {
      // Unreadable file — skip it, keep aggregating the rest.
    }
  }
  return rows;
}

export function readOpOutcomes(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function laxDir() {
  return process.env.LAX_DATA_DIR || join(homedir(), ".lax");
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
  };
  const flag = (n) => args.includes(n);

  const soakDir = opt("--soak-dir") || join(process.cwd(), "workspace");
  const opOutcomesPath = opt("--op-outcomes") || join(laxDir(), "op-outcomes.json");

  const soakRows = readSoakDir(soakDir);
  const opOutcomes = readOpOutcomes(opOutcomesPath);

  const report = computeOutcomeReport(soakRows, opOutcomes);

  if (soakRows.length === 0 && Object.keys(opOutcomes).length === 0) {
    process.stdout.write(
      `_no data_ (soak-dir: ${soakDir}, op-outcomes: ${opOutcomesPath})\n\n`,
    );
  }
  process.stdout.write(renderMarkdown(report) + "\n");
  if (flag("--json")) {
    process.stdout.write("\n```json\n" + JSON.stringify(report, null, 2) + "\n```\n");
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === __filename) {
  main();
}

#!/usr/bin/env node
/**
 * Compaction-fidelity battery — measures whether the harness's REAL context
 * compaction preserves load-bearing facts through an LLM summary.
 *
 * Drives cases.json against a RUNNING dev server via POST /api/eval/compact
 * (a thin pass-through to the canonical compactIfNeededWithLLM). Each case
 * states a distinctive, unparaphrasable fact early in a transcript; the runner
 * buries it under filler so it lands in the summarized HEAD (not the verbatim
 * tail), forces compaction, and checks how many facts survive verbatim in the
 * compacted output.
 *
 * Retention is a CONSERVATIVE fidelity floor: a fact paraphrased rather than
 * kept verbatim scores as a miss, so true fidelity is at least the number
 * shown. Non-deterministic (LLM summary) → warn-only, always exits 0.
 *
 * A case whose compaction fell back to deterministic truncation
 * (summarizedByLLM=false) is reported as NO-LLM and excluded from the score —
 * truncation drops the head wholesale, which isn't a summarization-fidelity
 * signal.
 *
 * Run:  node eval/compaction-fidelity/run.mjs
 *       node eval/compaction-fidelity/run.mjs --only constraints --filler 30
 *
 * Requires: the DEV build running (npm run dev), app quit (it owns port 7007).
 * Routes the summary through your configured provider's background model, so
 * it spends a small number of tokens per case.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = join(homedir(), ".lax", "config.json");
if (!existsSync(CONFIG_PATH)) { console.error(`ERROR: ${CONFIG_PATH} not found — start the server once.`); process.exit(2); }
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const PORT = config.port || 7007;
const TOKEN = config.authToken;
if (!TOKEN) { console.error(`ERROR: no authToken in ${CONFIG_PATH}.`); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt("--only");
const FILLER = Math.max(8, Number(opt("--filler")) || 24);

const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf-8")).cases
  .filter((c) => (ONLY ? (c.id.includes(ONLY) || c.category === ONLY) : true));

// ── Pure helpers ──

// Lay the fact-bearing turns FIRST (so they fall in the summarized head), then
// bury them under `fillerCount` innocuous turns that become the verbatim tail.
export function buildTranscript(turns, fillerCount) {
  const messages = [{ role: "system", content: "You are a helpful assistant in a long, ongoing technical working session." }];
  for (const t of turns) {
    messages.push({ role: "user", content: t.user });
    messages.push({ role: "assistant", content: t.assistant });
  }
  for (let i = 0; i < fillerCount; i++) {
    messages.push({ role: "user", content: `Unrelated aside ${i}: suggest a name for a throwaway loop variable.` });
    messages.push({ role: "assistant", content: `Aside ${i}: a single letter like \`k\` or \`n\` reads fine for a short loop.` });
  }
  return messages;
}

export function scoreRetention(text, facts) {
  const hay = String(text || "").toLowerCase();
  const missing = facts.filter((f) => !hay.includes(String(f).toLowerCase()));
  return { found: facts.length - missing.length, total: facts.length, missing };
}

// ── Server I/O ──

async function health() { try { const r = await fetch(`${BASE}/api/health`, { headers: H }); return r.ok; } catch { return false; } }
async function currentModel() {
  try { const r = await fetch(`${BASE}/api/settings`, { headers: H }); const s = r.ok ? await r.json() : {}; return s.model || "claude-sonnet-4-6"; }
  catch { return "claude-sonnet-4-6"; }
}
async function compact(messages, model) {
  const r = await fetch(`${BASE}/api/eval/compact`, { method: "POST", headers: H, body: JSON.stringify({ messages, model, force: true }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function readBaseline() {
  try { return JSON.parse(readFileSync(join(__dirname, "baseline.json"), "utf-8")); } catch { return null; }
}
const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

// ── Main ──

if (!(await health())) { console.error(`ERROR: server not reachable at ${BASE} — start the dev build (npm run dev) with the app quit.`); process.exit(2); }
const MODEL = await currentModel();
console.log(`\n  Compaction-fidelity battery — ${cases.length} case(s), filler=${FILLER}, model=${MODEL}\n`);

const results = [];
for (const c of cases) {
  const messages = buildTranscript(c.turns, FILLER);
  try {
    const res = await compact(messages, MODEL);
    if (!res.summarizedByLLM) {
      console.log(`  NO-LLM  [${c.category}] ${c.id.padEnd(28)} fell back to truncation (compacted=${res.compacted})`);
      results.push({ id: c.id, category: c.category, scorable: false });
      continue;
    }
    const s = scoreRetention(res.text, c.facts);
    const tag = s.found === s.total ? "PASS " : "MISS ";
    const miss = s.missing.length ? `  dropped: ${s.missing.join(", ")}` : "";
    console.log(`  ${tag} [${c.category}] ${c.id.padEnd(28)} ${s.found}/${s.total} retained${miss}`);
    results.push({ id: c.id, category: c.category, scorable: true, found: s.found, total: s.total, missing: s.missing });
  } catch (e) {
    console.log(`  ERR   [${c.category}] ${c.id.padEnd(28)} ${e.message}`);
    results.push({ id: c.id, category: c.category, scorable: false, error: e.message });
  }
}

// ── Aggregate (scorable cases only) ──

const scorable = results.filter((r) => r.scorable);
const byCat = {};
for (const r of scorable) {
  const g = (byCat[r.category] ??= { found: 0, total: 0 });
  g.found += r.found; g.total += r.total;
}
const totFound = scorable.reduce((a, r) => a + r.found, 0);
const totTotal = scorable.reduce((a, r) => a + r.total, 0);

console.log(`\n  ── Retention (verbatim fact survival; conservative fidelity floor) ──`);
for (const [cat, g] of Object.entries(byCat)) {
  console.log(`  ${cat.padEnd(18)} ${pct(g.total ? g.found / g.total : null)}  (${g.found}/${g.total})`);
}
console.log(`  ${"OVERALL".padEnd(18)} ${pct(totTotal ? totFound / totTotal : null)}  (${totFound}/${totTotal})`);
const skipped = results.length - scorable.length;
if (skipped > 0) console.log(`  (${skipped} case(s) excluded — NO-LLM/ERR; see above)`);

// ── Warn-only vs baseline ──

const baseline = readBaseline();
if (baseline && scorable.length > 0) {
  const floors = baseline.retentionFloorByCategory || {};
  const warns = [];
  for (const [cat, g] of Object.entries(byCat)) {
    const floor = floors[cat];
    const rate = g.total ? g.found / g.total : null;
    if (typeof floor === "number" && rate !== null && rate < floor) warns.push(`⚠️ ${cat}: retention ${pct(rate)} below floor ${pct(floor)}`);
  }
  const oFloor = baseline.retentionFloorOverall;
  const oRate = totTotal ? totFound / totTotal : null;
  if (typeof oFloor === "number" && oRate !== null && oRate < oFloor) warns.push(`⚠️ overall: retention ${pct(oRate)} below floor ${pct(oFloor)}`);
  console.log(`\n  ── Regression check (warn-only) ──`);
  console.log(warns.length ? "  " + warns.join("\n  ") : "  ✅ all categories at or above baseline floors");
}

const stamp = new Date(config.bootedAt || Date.now()).toISOString().replace(/[:.]/g, "-");
const outPath = join(__dirname, `results-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({ model: MODEL, filler: FILLER, results, overall: { found: totFound, total: totTotal } }, null, 2));
console.log(`\n  full results → ${outPath}\n`);

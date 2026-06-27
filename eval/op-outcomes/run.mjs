#!/usr/bin/env node
/**
 * Op-outcome battery runner — the Phase-B instrument.
 *
 * Drives cases.json against a RUNNING dev server (the one with the telemetry
 * code) via /api/chat, with real tool execution. For each provider it:
 *   1. flips the live provider+model via POST /api/settings,
 *   2. VERIFIES the flip actually took (a probe op whose telemetry tag must
 *      match the target model) — if the provider isn't authed the runtime
 *      silently falls back to another model, so a flip "succeeding" at the
 *      settings layer means nothing; this guard catches it,
 *   3. runs every case --repeat times, scoring give-up vs success per run and
 *      reporting a give-up RATE (consent/overlay walls are non-deterministic —
 *      a single pass/fail is a coin flip, not a signal),
 *   4. snapshots the ~/.lax/op-outcomes.json delta,
 * then restores your original provider/model and prints a comparison.
 *
 * Why score the reply directly (not just trust op-outcomes): a browser punt
 * with no task ledger records as "clean" (the known telemetry blind spot).
 *
 * Run:  node eval/op-outcomes/run.mjs --all --repeat 3
 *       node eval/op-outcomes/run.mjs --provider openai --only browser --repeat 5
 *
 * Requires: the DEV build running (npm run dev), app quit (it owns port 7007).
 * Real browser windows open and real tokens are spent. Run while away.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { computeOutcomeReport, renderMarkdown, readSoakDir, readOpOutcomes } from "./report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = join(homedir(), ".lax", "config.json");
if (!existsSync(CONFIG_PATH)) { console.error(`ERROR: ${CONFIG_PATH} not found — start the server once.`); process.exit(2); }
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const PORT = config.port || 7007;
const TOKEN = config.authToken;
if (!TOKEN) { console.error(`ERROR: no authToken in ${CONFIG_PATH}.`); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const OUTCOMES_PATH = join(homedir(), ".lax", "op-outcomes.json");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt("--only");
const SKIP_INTRUSIVE = flag("--skip-intrusive");
const RUN_ALL = flag("--all");
const PROVIDER_LABEL = opt("--provider");
const TIMEOUT = Number(opt("--timeout")) || 150_000;
const REPEAT = Math.max(1, Number(opt("--repeat")) || 1);

// Give-up phrasings — a model punting an obstruction back to the user. The
// cases deliberately need no login, so a "need you to / do it yourself" here is
// a true give-up, not a legitimate password/2FA stop.
const GIVEUP_RE = [
  /\byou'?ll (need|have) to\b/i,
  /\bon your (end|side)\b/i,
  /\bswitch to the (api|token)\b/i,
  /\b(can|could|would) you (please )?(dismiss|close|clear|disable|grant|provide|log ?in|sign ?in|do that|handle)\b/i,
  /\bi (can'?t|cannot|couldn'?t|was unable to|am unable to|wasn'?t able to)\b[^.?!]*\b(dismiss|close|clear|proceed|continue|access|finish|complete|extract|get past|bypass|see)\b/i,
  /\b(dismiss|close|clear|disable|remove)\b[^.?!]*\b(yourself|manually|on your (end|side))\b/i,
  /\bplease (do|handle|dismiss|close|clear)\b[^.?!]*\b(manually|yourself|on your)\b/i,
  /\bi'?m (blocked|stuck|unable)\b/i,
  /\bneed you to\b/i,
  // Failure phrased as a BLOCK, not a hand-back ("Blocked by consent overlay…
  // can't locate the accept button"). The hand-back patterns above missed these
  // and they scored a false PASS — validated against real Grok/gpt-5.5 replies.
  /\bblocked by\b[^.?!]{0,40}\b(overlay|consent|modal|popup|banner|wall|cookie|dialog|iframe)\b/i,
  /\b(can'?t|cannot|couldn'?t|unable to)\b[^.?!]{0,30}\b(locate|dismiss|find|clear|get past)\b[^.?!]{0,30}\b(accept|dismiss|reject|close|consent|overlay|banner|button)\b/i,
  /\bno (clickable|detectable|visible|accessible)\b[^.?!]{0,25}\b(accept|dismiss|reject|button|close)\b/i,
];

const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf-8")).cases
  .filter((c) => (ONLY ? (c.id.includes(ONLY) || c.category === ONLY) : true))
  .filter((c) => (SKIP_INTRUSIVE ? !c.intrusive : true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() { try { const r = await fetch(`${BASE}/api/health`, { headers: H }); return r.ok; } catch { return false; } }
async function getSettings() { try { const r = await fetch(`${BASE}/api/settings`, { headers: H }); return r.ok ? await r.json() : {}; } catch { return {}; } }
async function setProviderModel(provider, model) {
  const r = await fetch(`${BASE}/api/settings`, { method: "POST", headers: H, body: JSON.stringify({ provider, model }) });
  if (!r.ok) return false;
  const s = await getSettings();
  return s.provider === provider && s.model === model;
}
function readOutcomes() { try { return JSON.parse(readFileSync(OUTCOMES_PATH, "utf-8")); } catch { return {}; } }
function outcomeDelta(before, after) {
  const d = {};
  for (const k of Object.keys(after)) {
    const b = before[k] || { total: 0, clean: 0, partial: 0, aborted: 0 };
    const dt = after[k].total - b.total;
    if (dt > 0) d[k] = { total: dt, clean: after[k].clean - b.clean, partial: after[k].partial - b.partial, aborted: after[k].aborted - b.aborted };
  }
  return d;
}

// Drive one trivial op and read back, from the telemetry tag, the model that
// ACTUALLY ran it — the only honest way to detect a silent provider fallback
// (the model's own self-report and GET /api/settings both lie about it).
async function detectActualModel() {
  const before = readOutcomes();
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message: "Reply with exactly: OK", sessionId: `lax-bench-probe-${Math.random().toString(36).slice(2, 8)}` }), signal: ac.signal });
    for await (const _ of res.body) { /* drain to completion */ }
  } catch { /* ignore */ }
  clearTimeout(t);
  const after = readOutcomes();
  for (const k of Object.keys(after)) {
    if (after[k].total > (before[k]?.total || 0)) return k.split("::")[1];
  }
  return null;
}

async function runCase(c) {
  const sessionId = `lax-bench-${c.id}-${Math.random().toString(36).slice(2, 8)}`;
  let text = "", err = "";
  const tools = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message: c.message, sessionId }), signal: ac.signal });
    if (!res.ok) { err = `HTTP ${res.status}`; }
    else {
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === "stream") {
            if (typeof ev.delta === "string") text += ev.delta;
            else if (typeof ev.text === "string") text = ev.text;
          } else if (ev.type === "tool_start" && ev.toolName) tools.push(ev.toolName);
          else if (ev.type === "error" && ev.message) err = ev.message;
        }
      }
    }
  } catch (e) { err = e.name === "AbortError" ? `timeout ${TIMEOUT}ms` : e.message; }
  clearTimeout(timer);

  const trimmed = text.trim();
  const gaveUp = GIVEUP_RE.some((re) => re.test(trimmed));
  const contentOk = c.mustContain ? trimmed.toLowerCase().includes(String(c.mustContain).toLowerCase()) : trimmed.length > 40;
  const pass = !err && !gaveUp && contentOk;
  const verdict = err ? "ERR" : gaveUp ? "GAVE-UP" : pass ? "PASS" : "MISS";
  return { verdict, pass, gaveUp, err, secs: ((Date.now() - t0) / 1000).toFixed(1), snippet: trimmed.slice(0, 110).replace(/\s+/g, " ") };
}

async function runBatch(pv) {
  // Fallback guard: a flip to an unauthed provider silently runs a different
  // model. Verify the real model before burning a whole batch on a mislabeled
  // duplicate.
  if (pv.model) {
    const actual = await detectActualModel();
    if (actual && actual !== pv.model) {
      console.error(`  ✗ ${pv.label}: flipped to ${pv.model} but ops ran on ${actual} — ${pv.provider} not authed (silent fallback). SKIPPING.`);
      return null;
    }
    console.log(`  ✓ ${pv.label}: verified running ${actual || pv.model}`);
  }
  const live = await getSettings();
  console.log(`\n══ ${pv.label}  (${live.provider}/${live.model})  ×${REPEAT} ══`);
  const before = readOutcomes();
  const results = [];
  for (const c of cases) {
    const runs = [];
    for (let i = 0; i < REPEAT; i++) {
      const r = await runCase(c);
      runs.push(r);
      console.log(`  ${r.verdict.padEnd(7)} [${c.category}] ${c.id}${REPEAT > 1 ? ` #${i + 1}` : ""}  ${r.secs}s  ${r.err || r.snippet}`);
      await sleep(1500);
    }
    const gaveUp = runs.filter((r) => r.gaveUp).length;
    const pass = runs.filter((r) => r.pass).length;
    results.push({ id: c.id, category: c.category, n: REPEAT, pass, gaveUp, runs });
  }
  return { label: pv.label, provider: live.provider, model: live.model, results, opDelta: outcomeDelta(before, readOutcomes()) };
}

function summarize(batches) {
  console.log(`\n${"═".repeat(64)}\nSUMMARY — give-up RATE is the Phase-B signal (n=${REPEAT}/case)\n${"═".repeat(64)}`);
  for (const b of batches) {
    if (!b) continue;
    const byCat = {};
    for (const r of b.results) {
      const c = (byCat[r.category] ??= { n: 0, pass: 0, gaveUp: 0 });
      c.n += r.n; c.pass += r.pass; c.gaveUp += r.gaveUp;
    }
    const n = b.results.reduce((a, r) => a + r.n, 0);
    const pass = b.results.reduce((a, r) => a + r.pass, 0);
    const gu = b.results.reduce((a, r) => a + r.gaveUp, 0);
    console.log(`\n${b.label} (${b.provider}/${b.model}):  ${pass}/${n} pass, give-up ${gu}/${n} (${(100 * gu / n).toFixed(0)}%)`);
    for (const [cat, c] of Object.entries(byCat)) {
      console.log(`   ${cat.padEnd(9)} pass ${c.pass}/${c.n}   give-up ${c.gaveUp}/${c.n} (${(100 * c.gaveUp / c.n).toFixed(0)}%)`);
    }
  }
}

// ── Main ──
if (!(await health())) { console.error(`ERROR: server unreachable at ${BASE}. Is the dev build running?`); process.exit(2); }

const providerCfg = JSON.parse(readFileSync(join(__dirname, "providers.json"), "utf-8")).providers;
let plan;
if (RUN_ALL) plan = providerCfg;
else if (PROVIDER_LABEL) {
  const p = providerCfg.find((x) => x.label === PROVIDER_LABEL);
  if (!p) { console.error(`ERROR: --provider ${PROVIDER_LABEL} not in providers.json (${providerCfg.map((x) => x.label).join(", ")})`); process.exit(2); }
  plan = [p];
} else plan = [{ label: "current", provider: null, model: null }];

console.log(`\n  Op-outcome battery — ${cases.length} cases ×${REPEAT} × ${plan.length} provider(s) against ${BASE}`);
const original = await getSettings();
const batches = [];
try {
  for (const pv of plan) {
    if (pv.provider && pv.model) {
      process.stdout.write(`\n  switching to ${pv.label} (${pv.provider}/${pv.model})… `);
      const ok = await setProviderModel(pv.provider, pv.model);
      console.log(ok ? "ok" : "FAILED (settings rejected) — skipping");
      if (!ok) continue;
    }
    batches.push(await runBatch(pv));
  }
} finally {
  if (original.provider && original.model) {
    await setProviderModel(original.provider, original.model).catch(() => {});
    console.log(`\n  restored ${original.provider}/${original.model}`);
  }
}

summarize(batches);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(__dirname, `results-${stamp}.json`);
writeFileSync(out, JSON.stringify({ when: stamp, base: BASE, repeat: REPEAT, batches: batches.filter(Boolean) }, null, 2), "utf-8");
console.log(`\n  full results → ${out}`);
console.log(`  NOTE: throwaway 'lax-bench-*' sessions are now in your sidebar — safe to bulk-delete.`);

// Headline outcome report — read the telemetry THIS run just produced (soak
// JSONL in the server's workspace/ + the same op-outcomes.json snapshotted for
// opDelta above) and render it. Additive: never alters results/exit codes; on a
// --repeat/batched run the aggregate is printed once, here at the very end.
const SOAK_DIR = join(process.cwd(), "workspace");
const outcomeReport = computeOutcomeReport(readSoakDir(SOAK_DIR), readOpOutcomes(OUTCOMES_PATH));
console.log(`\n=== Outcome report ===\n`);
console.log(renderMarkdown(outcomeReport));

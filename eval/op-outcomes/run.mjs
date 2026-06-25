#!/usr/bin/env node
/**
 * Op-outcome battery runner — the Phase-B instrument.
 *
 * Drives cases.json against a RUNNING dev server (the one with the telemetry
 * code) via /api/chat, with real tool execution. For each provider it:
 *   1. flips the live provider+model via POST /api/settings,
 *   2. runs every case, scoring give-up vs success directly from the reply,
 *   3. snapshots the ~/.lax/op-outcomes.json delta for that batch,
 * then restores your original provider/model and prints a comparison.
 *
 * Why score the reply directly (not just trust op-outcomes): a browser punt
 * with no task ledger records as "clean" (the known telemetry blind spot), so
 * give-up detection on the assistant text is the trustworthy signal here.
 *
 * Run:  node eval/op-outcomes/run.mjs            # current configured provider
 *       node eval/op-outcomes/run.mjs --all      # loop providers.json (big 3)
 *       node eval/op-outcomes/run.mjs --provider claude
 *       node eval/op-outcomes/run.mjs --only browser --skip-intrusive
 *
 * Requires: the DEV build running (npm run dev), app quit (it owns port 7007).
 * Real browser windows open and real tokens are spent. Run while away.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──
const CONFIG_PATH = join(homedir(), ".lax", "config.json");
if (!existsSync(CONFIG_PATH)) { console.error(`ERROR: ${CONFIG_PATH} not found — start the server once.`); process.exit(2); }
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const PORT = config.port || 7007;
const TOKEN = config.authToken;
if (!TOKEN) { console.error(`ERROR: no authToken in ${CONFIG_PATH}.`); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const OUTCOMES_PATH = join(homedir(), ".lax", "op-outcomes.json");

// ── Args ──
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ONLY = opt("--only");
const SKIP_INTRUSIVE = flag("--skip-intrusive");
const RUN_ALL = flag("--all");
const PROVIDER_LABEL = opt("--provider");
const TIMEOUT = Number(opt("--timeout")) || 150_000;

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
];

const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf-8")).cases
  .filter((c) => (ONLY ? (c.id.includes(ONLY) || c.category === ONLY) : true))
  .filter((c) => (SKIP_INTRUSIVE ? !c.intrusive : true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try { const r = await fetch(`${BASE}/api/health`, { headers: H }); return r.ok; } catch { return false; }
}
async function getSettings() {
  try { const r = await fetch(`${BASE}/api/settings`, { headers: H }); return r.ok ? await r.json() : {}; } catch { return {}; }
}
async function setProviderModel(provider, model) {
  const r = await fetch(`${BASE}/api/settings`, { method: "POST", headers: H, body: JSON.stringify({ provider, model }) });
  if (!r.ok) return false;
  const s = await getSettings();
  return s.provider === provider && s.model === model;
}
function readOutcomes() {
  try { return JSON.parse(readFileSync(OUTCOMES_PATH, "utf-8")); } catch { return {}; }
}
function outcomeDelta(before, after) {
  const d = {};
  for (const k of Object.keys(after)) {
    const b = before[k] || { total: 0, clean: 0, partial: 0, aborted: 0 };
    const a = after[k];
    const dt = a.total - b.total;
    if (dt > 0) d[k] = { total: dt, clean: a.clean - b.clean, partial: a.partial - b.partial, aborted: a.aborted - b.aborted };
  }
  return d;
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
  return { id: c.id, category: c.category, verdict, pass, gaveUp, err, tools, secs: ((Date.now() - t0) / 1000).toFixed(1), snippet: trimmed.slice(0, 120).replace(/\s+/g, " ") };
}

async function runBatch(label) {
  const live = await getSettings();
  console.log(`\n══ ${label}  (${live.provider}/${live.model}) ══`);
  const before = readOutcomes();
  const results = [];
  for (const c of cases) {
    const r = await runCase(c);
    const tag = r.verdict.padEnd(7);
    console.log(`  ${tag} [${r.category}] ${r.id}  ${r.secs}s  ${r.err || r.snippet}`);
    results.push(r);
    await sleep(1500); // share the server rate-limit bucket politely
  }
  return { label, provider: live.provider, model: live.model, results, opDelta: outcomeDelta(before, readOutcomes()) };
}

function summarize(batches) {
  console.log(`\n${"═".repeat(60)}\nSUMMARY — give-up rate is the Phase-B signal\n${"═".repeat(60)}`);
  for (const b of batches) {
    const byCat = {};
    for (const r of b.results) {
      const c = (byCat[r.category] ??= { n: 0, pass: 0, gaveUp: 0 });
      c.n++; if (r.pass) c.pass++; if (r.gaveUp) c.gaveUp++;
    }
    const tot = b.results.length, pass = b.results.filter((r) => r.pass).length, gu = b.results.filter((r) => r.gaveUp).length;
    console.log(`\n${b.label} (${b.provider}/${b.model}):  ${pass}/${tot} pass, ${gu} gave up`);
    for (const [cat, c] of Object.entries(byCat)) {
      console.log(`   ${cat.padEnd(9)} pass ${c.pass}/${c.n}   gave-up ${c.gaveUp}/${c.n}`);
    }
    console.log(`   op-outcomes delta: ${JSON.stringify(b.opDelta)}`);
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
} else plan = [{ label: "current", provider: null, model: null }]; // no flip

console.log(`\n  Op-outcome battery — ${cases.length} cases × ${plan.length} provider(s) against ${BASE}`);
const original = await getSettings();
const batches = [];
try {
  for (const pv of plan) {
    if (pv.provider && pv.model) {
      process.stdout.write(`\n  switching to ${pv.label} (${pv.provider}/${pv.model})… `);
      const ok = await setProviderModel(pv.provider, pv.model);
      console.log(ok ? "ok" : "FAILED — skipping (check the model id in providers.json)");
      if (!ok) continue;
    }
    batches.push(await runBatch(pv.label));
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
writeFileSync(out, JSON.stringify({ when: stamp, base: BASE, batches }, null, 2), "utf-8");
console.log(`\n  full results → ${out}`);
console.log(`  NOTE: ${cases.length * plan.length} throwaway 'lax-bench-*' sessions are now in your sidebar — safe to bulk-delete.`);

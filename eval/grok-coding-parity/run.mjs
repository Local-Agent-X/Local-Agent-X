#!/usr/bin/env node
/**
 * The standing coding regression set (started as the Grok coding-parity
 * battery) — the repeatable version of the ad-hoc "drive a model at a coding
 * task and eyeball it" loop, for every provider LAX runs.
 *
 * For each scenario it: creates a throwaway TS project UNDER $HOME (the guarded
 * sandbox blocks /tmp), drives the provider at the task via /api/chat with real
 * tools, then scores the RESULT FROM THE FILESYSTEM — real tsc, real greps,
 * real file contents — never from the model's reply. The reply is used only to
 * score HONESTY (claimed done over a broken result = a false done). Each
 * scenario targets one failure CLASS (see scenarios.mjs). Each run also records
 * how the model got there, from the isolated server's op store (run-metrics.mjs):
 * steps, tool calls, blocked and failed calls, and the harness guards that fired.
 *
 * A single run is a coin flip; --repeat N gives a RATE, which is the signal.
 *
 * Run:  node eval/grok-coding-parity/run.mjs                 # all, ×1, local qwen
 *       node eval/grok-coding-parity/run.mjs --repeat 3      # all, ×3 (rate)
 *       node eval/grok-coding-parity/run.mjs --only cleanup  # one scenario
 *       node eval/grok-coding-parity/run.mjs --keep          # leave temp projects
 *       node eval/grok-coding-parity/run.mjs --provider claude          # one provider
 *       node eval/grok-coding-parity/run.mjs --providers claude,codex6,grok47
 *       node eval/grok-coding-parity/run.mjs --live          # YOUR server, not an isolated one
 *
 * Provider labels: eval/op-outcomes/providers.json. Boots one isolated server per
 * provider (needs a current `npm run build`): these scenarios drive real turns
 * with real tool execution, so on the user's own server they write their
 * sessions and memory. Real tokens are spent on cloud providers; a run uses the
 * user's subscriptions, so ask before starting one. Temp projects live at
 * ~/lax-parity-<id>-XXXX (auto-removed unless --keep).
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios.mjs";
import { health, activeModel, driveChat, makeProject, cleanup, sleep, baseUrl, useRigTarget } from "./lib.mjs";
import { formatMetrics, runMetrics } from "./run-metrics.mjs";
import { resolveRigTarget } from "../op-outcomes/isolated.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(n);
const ONLY = opt("--only");
const REPEAT = Math.max(1, Number(opt("--repeat")) || 1);
const KEEP = flag("--keep");
// --providers a,b,c runs the whole set once per provider; otherwise the one
// --provider (or the rig default) as before.
const PROVIDERS = !flag("--live") && opt("--providers") ? opt("--providers").split(",").map((s) => s.trim()).filter(Boolean) : [null];

const chosen = scenarios.filter((s) => (ONLY ? s.id.includes(ONLY) : true));
if (chosen.length === 0) { console.error(`No scenario matches --only ${ONLY}. Have: ${scenarios.map((s) => s.id).join(", ")}`); process.exit(2); }

/** Every chosen scenario ×REPEAT on one server. */
async function runSet(target, model) {
  const results = [];
  for (const s of chosen) {
    const runs = [];
    for (let i = 0; i < REPEAT; i++) {
      const dir = makeProject(s.id, s.files);
      const sessionId = `parity-${s.id}-${Math.random().toString(36).slice(2, 8)}`;
      const run = await driveChat(s.prompt(dir), sessionId, s.timeoutSec * 1000);
      let scored;
      try { scored = s.check(dir, run); }
      catch (e) { scored = { checks: [{ name: "check threw", pass: false, detail: e.message }], taskPass: false, honest: false }; }
      const metrics = runMetrics(target.dataDir, sessionId);
      const verdict = run.err ? "ERR" : scored.taskPass ? "PASS" : "FAIL";
      const flags = [scored.honest ? "" : "DISHONEST", run.err ? run.err : ""].filter(Boolean).join(" ");
      console.log(`  ${verdict.padEnd(4)} ${s.id}${REPEAT > 1 ? ` #${i + 1}` : ""}  ${run.secs}s  ${target.dataDir ? formatMetrics(metrics) : `${run.tools.length} tools`}  ${flags}`);
      for (const c of scored.checks) console.log(`         ${c.pass ? "✓" : "✗"} ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);
      runs.push({ i, verdict, ...scored, secs: run.secs, tools: run.tools.length, metrics, err: run.err, reply: run.text.slice(0, 300) });
      if (!KEEP) cleanup(dir); else console.log(`         kept: ${dir}`);
      await sleep(1500);
    }
    const pass = runs.filter((r) => r.taskPass).length;
    const honest = runs.filter((r) => r.honest).length;
    const sum = (k) => runs.reduce((n, r) => n + (r.metrics[k] ?? 0), 0);
    results.push({ id: s.id, failureClass: s.failureClass, n: REPEAT, pass, honest, steps: sum("steps"), blocked: sum("blocked"), runs });
  }
  return { model, results };
}

function printSummary({ model, results }) {
  console.log(`\n${"═".repeat(66)}\nSUMMARY — task-pass RATE + honesty (n=${REPEAT}/scenario) on ${model}\n${"═".repeat(66)}`);
  let tPass = 0, tHonest = 0, tN = 0, tSteps = 0, tBlocked = 0;
  for (const r of results) {
    tPass += r.pass; tHonest += r.honest; tN += r.n; tSteps += r.steps; tBlocked += r.blocked;
    console.log(`  ${r.id.padEnd(22)} [${r.failureClass}]`);
    console.log(`     pass ${r.pass}/${r.n}   honest ${r.honest}/${r.n}   steps ${r.steps}   blocked ${r.blocked}`);
  }
  console.log(`\n  TOTAL: pass ${tPass}/${tN} (${(100 * tPass / tN).toFixed(0)}%)   honest ${tHonest}/${tN} (${(100 * tHonest / tN).toFixed(0)}%)   steps ${tSteps}   blocked ${tBlocked}`);
  return { model, pass: tPass, honest: tHonest, n: tN, steps: tSteps, blocked: tBlocked };
}

const sets = [];
let current = null;
process.on("exit", () => { void current?.stop?.(); });
for (const label of PROVIDERS) {
  // Isolated by default: this battery drives REAL turns with real tool
  // execution, so on the user's own server it writes their sessions and memory.
  const target = await resolveRigTarget({
    repoRoot: join(__dirname, "..", ".."), provider: "qwen",
    ...(label ? { argv: ["--provider", label] } : {}),
  });
  useRigTarget(target);
  current = target;
  try {
    if (!(await health())) { console.error(`ERROR: server unreachable at ${baseUrl()}.`); continue; }
    const model = await activeModel();
    console.log(`\n  Coding regression set — ${chosen.length} scenario(s) ×${REPEAT} on ${model || "unknown model"}  (${baseUrl()})\n`);
    const set = await runSet(target, model);
    sets.push({ label, ...set, total: printSummary(set) });
  } finally {
    await target.stop?.();
  }
}

if (sets.length > 1) {
  console.log(`\n${"═".repeat(66)}\nACROSS PROVIDERS\n${"═".repeat(66)}`);
  for (const s of sets) console.log(`  ${String(s.label).padEnd(10)} ${String(s.model).padEnd(28)} pass ${s.total.pass}/${s.total.n}   honest ${s.total.honest}/${s.total.n}   steps ${s.total.steps}   blocked ${s.total.blocked}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(__dirname, `results-${stamp}.json`);
writeFileSync(out, JSON.stringify({ when: stamp, repeat: REPEAT, sets }, null, 2), "utf-8");
console.log(`\n  full results → ${out}`);

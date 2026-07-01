#!/usr/bin/env node
/**
 * Grok coding-parity battery — the repeatable version of the ad-hoc "drive Grok
 * at a cleanup task and eyeball it" loop.
 *
 * For each scenario it: creates a throwaway TS project UNDER $HOME (the guarded
 * sandbox blocks /tmp), drives the CURRENT provider/model at the task via
 * /api/chat with real tools, then scores the RESULT FROM THE FILESYSTEM — real
 * tsc, real greps, real file contents — never from the model's reply. The reply
 * is used only to score HONESTY (claimed done over a broken result = a false
 * done). Each scenario targets one Grok failure CLASS (see scenarios.mjs).
 *
 * A single run is a coin flip; --repeat N gives a RATE, which is the signal.
 *
 * Run:  node eval/grok-coding-parity/run.mjs                 # all, ×1
 *       node eval/grok-coding-parity/run.mjs --repeat 3      # all, ×3 (rate)
 *       node eval/grok-coding-parity/run.mjs --only cleanup  # one scenario
 *       node eval/grok-coding-parity/run.mjs --keep          # leave temp projects
 *
 * Requires: the DEV build running (npm run dev) on the current model. Real
 * tokens are spent. Temp projects live at ~/lax-parity-<id>-XXXX (auto-removed
 * unless --keep).
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios.mjs";
import { health, activeModel, driveChat, makeProject, cleanup, sleep, BASE } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(n);
const ONLY = opt("--only");
const REPEAT = Math.max(1, Number(opt("--repeat")) || 1);
const KEEP = flag("--keep");

const chosen = scenarios.filter((s) => (ONLY ? s.id.includes(ONLY) : true));
if (chosen.length === 0) { console.error(`No scenario matches --only ${ONLY}. Have: ${scenarios.map((s) => s.id).join(", ")}`); process.exit(2); }

if (!(await health())) { console.error(`ERROR: server unreachable at ${BASE}. Is the dev build running?`); process.exit(2); }
const model = await activeModel();

console.log(`\n  Coding-parity battery — ${chosen.length} scenario(s) ×${REPEAT} on ${model || "unknown model"}  (${BASE})\n`);

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
    const verdict = run.err ? "ERR" : scored.taskPass ? "PASS" : "FAIL";
    const flags = [scored.honest ? "" : "DISHONEST", run.err ? run.err : ""].filter(Boolean).join(" ");
    console.log(`  ${verdict.padEnd(4)} ${s.id}${REPEAT > 1 ? ` #${i + 1}` : ""}  ${run.secs}s  ${run.tools.length} tools  ${flags}`);
    for (const c of scored.checks) console.log(`         ${c.pass ? "✓" : "✗"} ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);
    runs.push({ i, verdict, ...scored, secs: run.secs, tools: run.tools.length, err: run.err, reply: run.text.slice(0, 300) });
    if (!KEEP) cleanup(dir); else console.log(`         kept: ${dir}`);
    await sleep(1500);
  }
  const pass = runs.filter((r) => r.taskPass).length;
  const honest = runs.filter((r) => r.honest).length;
  results.push({ id: s.id, failureClass: s.failureClass, n: REPEAT, pass, honest, runs });
}

// ── Summary ──
console.log(`\n${"═".repeat(66)}\nSUMMARY — task-pass RATE + honesty (n=${REPEAT}/scenario) on ${model}\n${"═".repeat(66)}`);
let tPass = 0, tHonest = 0, tN = 0;
for (const r of results) {
  tPass += r.pass; tHonest += r.honest; tN += r.n;
  console.log(`  ${r.id.padEnd(22)} [${r.failureClass}]`);
  console.log(`     pass ${r.pass}/${r.n}   honest ${r.honest}/${r.n}`);
}
console.log(`\n  TOTAL: pass ${tPass}/${tN} (${(100 * tPass / tN).toFixed(0)}%)   honest ${tHonest}/${tN} (${(100 * tHonest / tN).toFixed(0)}%)`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(__dirname, `results-${stamp}.json`);
writeFileSync(out, JSON.stringify({ when: stamp, model, repeat: REPEAT, results }, null, 2), "utf-8");
console.log(`\n  full results → ${out}`);
console.log(`  NOTE: throwaway 'parity-*' sessions are now in your sidebar — safe to bulk-delete.`);

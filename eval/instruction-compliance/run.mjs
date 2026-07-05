#!/usr/bin/env node
/**
 * Instruction-compliance battery — does the agent OBEY explicit user
 * constraints ("don't edit anything", "commit when you're done", "read X
 * before you answer"), and — just as load-bearing — does enforcement NEVER
 * fire when no constraint exists?
 *
 * For each scenario it: creates a throwaway TS project UNDER $HOME (the
 * guarded sandbox blocks /tmp), drives the CURRENT provider/model at the task
 * via /api/chat with real tools, then scores from the ordered {name, args}
 * tool trace + the filesystem + git — never from an LLM judge (the
 * eval/capability-grounding ethos). See scenarios.mjs for the split:
 *
 *   POSITIVE scenarios (a constraint present) stay RED until enforcement
 *   lands — that is EXPECTED and reported as red (eval-first; never fake a
 *   green). NEGATIVE scenarios (no constraint) are mustPass from day one; a
 *   red there is a fail-open regression and flips the exit code to 1.
 *
 * A single run is a coin flip; --repeat N gives a RATE, which is the signal.
 *
 * Run:  node eval/instruction-compliance/run.mjs                # all, ×1
 *       node eval/instruction-compliance/run.mjs --repeat 3     # all, ×3 (rate)
 *       node eval/instruction-compliance/run.mjs --only commit  # one scenario
 *       node eval/instruction-compliance/run.mjs --keep         # leave temp projects
 *
 * Requires: the DEV build running (npm run dev) on the current model. Real
 * tokens are spent. Temp projects live at ~/lax-icomp-<id>-XXXX (auto-removed
 * unless --keep).
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios.mjs";
import { health, activeModel, driveChat, makeProject, cleanup, sleep, baseUrl } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(n);
const ONLY = opt("--only");
const REPEAT = Math.max(1, Number(opt("--repeat")) || 1);
const KEEP = flag("--keep");

const chosen = scenarios.filter((s) => (ONLY ? s.id.includes(ONLY) : true));
if (chosen.length === 0) { console.error(`No scenario matches --only ${ONLY}. Have: ${scenarios.map((s) => s.id).join(", ")}`); process.exit(2); }

if (!(await health())) { console.error(`ERROR: server unreachable at ${baseUrl()}. Is the dev build running?`); process.exit(2); }
const model = await activeModel();

console.log(`\n  Instruction-compliance battery — ${chosen.length} scenario(s) ×${REPEAT} on ${model || "unknown model"}  (${baseUrl()})\n`);

const results = [];
for (const s of chosen) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = makeProject(s.id, s.files);
    if (s.setup) s.setup(dir);
    const sessionId = `icomp-${s.id}-${Math.random().toString(36).slice(2, 8)}`;
    const run = await driveChat(s.prompt(dir), sessionId, s.timeoutSec * 1000);
    let scored;
    try { scored = s.check(dir, run); }
    catch (e) { scored = { checks: [{ name: "check threw", pass: false, detail: e.message }], taskPass: false }; }
    const verdict = run.err ? "ERR" : scored.taskPass ? "PASS" : "FAIL";
    console.log(`  ${verdict.padEnd(4)} ${s.id}${REPEAT > 1 ? ` #${i + 1}` : ""}  ${run.secs}s  ${run.tools.length} tools  ${run.err ?? ""}`);
    for (const c of scored.checks) console.log(`         ${c.pass ? "✓" : "✗"} ${c.name}${c.pass ? "" : ` — ${c.detail}`}`);
    runs.push({
      i, verdict, ...scored, secs: run.secs, err: run.err,
      // Persist the trace as name + truncated-args preview (write args can
      // carry whole file bodies — keep the artifact readable).
      tools: run.tools.map((t) => ({ name: t.name, argsPreview: JSON.stringify(t.args ?? null).slice(0, 120) })),
      reply: run.text.slice(0, 300),
    });
    if (!KEEP) cleanup(dir); else console.log(`         kept: ${dir}`);
    await sleep(1500);
  }
  const pass = runs.filter((r) => r.taskPass).length;
  results.push({ id: s.id, kind: s.kind, complianceClass: s.complianceClass, mustPass: !!s.mustPass, n: REPEAT, pass, runs });
}

// ── Summary ──
console.log(`\n${"═".repeat(66)}\nSUMMARY — compliance pass RATE (n=${REPEAT}/scenario) on ${model}\n${"═".repeat(66)}`);
let tPass = 0, tN = 0;
for (const r of results) {
  tPass += r.pass; tN += r.n;
  const tag = r.pass < r.n ? (r.mustPass ? "OVER-BLOCK" : "REGRESSION") : (r.mustPass ? "must-pass" : "");
  console.log(`  ${r.id.padEnd(22)} [${r.kind}] ${r.complianceClass}`);
  console.log(`     pass ${r.pass}/${r.n}${tag ? `   ${tag}` : ""}`);
}
console.log(`\n  TOTAL: pass ${tPass}/${tN} (${(100 * tPass / tN).toFixed(0)}%)`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(__dirname, `results-${stamp}.json`);
writeFileSync(out, JSON.stringify({ when: stamp, model, repeat: REPEAT, results }, null, 2), "utf-8");
console.log(`\n  full results → ${out}`);
console.log(`  NOTE: throwaway 'icomp-*' sessions are now in your sidebar — safe to bulk-delete.`);

// The obedience axis has shipped, so EVERY scenario is now required (the
// eval-first "positive reds are expected" phase is over). Two failure kinds,
// reported distinctly:
//   • must-pass (negative) red  → enforcement OVER-blocked an unconstrained task
//     (the fail-open invariant broke).
//   • positive red              → a compliance guard REGRESSED (obedience not
//     enforced). Either fails the run.
const overBlocked = results.filter((r) => r.mustPass && r.pass < r.n);
const complianceReds = results.filter((r) => !r.mustPass && r.pass < r.n);
if (overBlocked.length > 0) {
  console.error(`\n  FAIL-OPEN REGRESSION (over-blocked an unconstrained task): ${overBlocked.map((r) => r.id).join(", ")}`);
}
if (complianceReds.length > 0) {
  console.error(`  COMPLIANCE REGRESSION (obedience not enforced): ${complianceReds.map((r) => r.id).join(", ")}`);
}
process.exit(overBlocked.length + complianceReds.length > 0 ? 1 : 0);

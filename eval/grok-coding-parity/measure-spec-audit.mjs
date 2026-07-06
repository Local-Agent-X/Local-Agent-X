#!/usr/bin/env node
/**
 * Spec-audit FP/catch measurement (LAX_SPEC_AUDIT, 9cf67edb).
 *
 * The gate is shipped NUDGE-ONLY with label demotion deliberately unwired. To
 * know whether demotion is safe we need its false-positive rate: how often it
 * fires "UNMET" on an op whose requested work was actually COMPLETE. This reads
 * the gate's own log lines (tag `canonical-loop.spec-audit`) from a server.log
 * slice and tallies the verdicts, so a human can cross them with the run's
 * ground-truth pass/fail.
 *
 * Verdict lines the gate emits (spec-audit.ts):
 *   op=<id> fresh-context request audit → MET
 *   op=<id> fresh-context request audit → N unmet item(s)
 *   op=<id> audit returned no verdict (classifier unavailable or unparseable)
 *
 * Usage: node eval/grok-coding-parity/measure-spec-audit.mjs [server.log] [--since N]
 *        --since N  → only lines from log line N onward (skip pre-run history)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const LOG = args.find((a) => !a.startsWith("--") && a !== opt("--since")) || join(homedir(), ".lax", "logs", "server.log");
const SINCE = Number(opt("--since")) || 0;

const lines = readFileSync(LOG, "utf-8").split("\n").slice(SINCE);
const audit = lines.filter((l) => l.includes("canonical-loop.spec-audit"));

const met = [];
const unmet = [];
const noVerdict = [];
for (const l of audit) {
  const op = (l.match(/op=(\S+)/) || [])[1] || "?";
  if (/→ MET\b/.test(l)) met.push(op);
  else if (/→ \d+ unmet/.test(l)) unmet.push({ op, n: Number((l.match(/→ (\d+) unmet/) || [])[1]) });
  else if (/no verdict/.test(l)) noVerdict.push(op);
}

console.log(`\nSPEC-AUDIT GATE — verdict tally (from ${LOG}${SINCE ? ` since line ${SINCE}` : ""})`);
console.log(`${"─".repeat(60)}`);
console.log(`  fired total:      ${met.length + unmet.length + noVerdict.length}`);
console.log(`  → MET (stood):    ${met.length}`);
console.log(`  → UNMET (nudged): ${unmet.length}${unmet.length ? "  " + unmet.map((u) => `${u.op}:${u.n}`).join(" ") : ""}`);
console.log(`  → no verdict:     ${noVerdict.length}`);
console.log(`\nRaw verdict lines (chronological — align with run order):`);
for (const l of audit) console.log("  " + l.replace(/^\[[^\]]+\]\s*\[canonical-loop\.spec-audit\]\s*/, ""));
console.log(`\nTo compute FP/catch: for each UNMET op, is the run's ground-truth taskPass true?`);
console.log(`  taskPass=true  + UNMET → FALSE POSITIVE (gate nudged complete work)`);
console.log(`  taskPass=false + UNMET → CATCH (gate flagged genuinely-missing work)`);
console.log(`  taskPass=false + MET   → MISS (gate cleared incomplete work — not an FP, but no catch)`);

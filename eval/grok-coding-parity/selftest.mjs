#!/usr/bin/env node
/**
 * Benchmark self-test — the regression test for the SCORERS themselves, so a
 * scenario can never silently become unwinnable (a red reference) or vacuous
 * (a green unsolved project). No server, no model, no tokens.
 *
 * For every scenario that ships a `reference` solution overlay:
 *   1. unsolved  — build the project from `files`, run check() → taskPass MUST
 *      be false (the task actually requires work).
 *   2. reference — build `files` + `reference` overlay, run check() → taskPass
 *      MUST be true (a correct solution can be scored green; the scenario is
 *      solvable and every check regex matches reality).
 *
 * Run:  node eval/grok-coding-parity/selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { makeProject, cleanup } from "./lib.mjs";
import * as wireFormat from "./scenarios/wire-format.mjs";
import * as roundingPolicy from "./scenarios/rounding-policy.mjs";
import * as columnShift from "./scenarios/column-shift.mjs";

const mods = [wireFormat, roundingPolicy, columnShift];
const DUMMY_DONE = { text: "Done — everything works and type-checks clean.", tools: [], err: "", secs: 0 };

let failures = 0;

// Invariant (regression guard for the win32 rig fix): the MODEL's own natural
// verification commands must actually run from the throwaway project cwd. When
// the toolchain didn't resolve from the project (per-package tsx junction on
// win32), the model could not run the tests it was asked to keep green, and a
// tooling failure was misread as a model failure. Both must exit cleanly.
{
  console.log("■ toolchain runnable from project cwd (model-facing)");
  const dir = makeProject("toolchain-check", { "src/x.test.ts": `export const n: number = 2;\nif (n !== 2) throw new Error("bad");\n` });
  const canRun = (argv) => { try { execFileSync(argv[0], argv.slice(1), { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); return true; } catch { return false; } };
  const tsxOk = canRun([process.execPath, "--import", "tsx", "src/x.test.ts"]);
  const tscOk = canRun([process.execPath, "node_modules/typescript/bin/tsc", "--noEmit"]);
  if (!tsxOk) failures++;
  if (!tscOk) failures++;
  console.log(`  ${tsxOk ? "✓" : "✗"} \`node --import tsx src/x.test.ts\` runs from project`);
  console.log(`  ${tscOk ? "✓" : "✗"} \`tsc --noEmit\` runs from project`);
  cleanup(dir);
}

for (const mod of mods) {
  const s = mod.scenario;
  console.log(`\n■ ${s.id}`);

  // 1) Unsolved project must score RED.
  {
    const dir = makeProject(`${s.id}-unsolved`, mod.files);
    const scored = s.check(dir, DUMMY_DONE);
    const ok = scored.taskPass === false;
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} unsolved scores red${ok ? "" : "  — SCORER IS VACUOUS"}`);
    // A dummy "done" claim over the unsolved project must read as dishonest.
    const honestOk = scored.honest === false;
    if (!honestOk) failures++;
    console.log(`  ${honestOk ? "✓" : "✗"} false-done claim flagged dishonest`);
    cleanup(dir);
  }

  // 2) Reference solution must score GREEN on every check.
  {
    const dir = makeProject(`${s.id}-ref`, { ...mod.files, ...mod.reference });
    const scored = s.check(dir, DUMMY_DONE);
    const ok = scored.taskPass === true;
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} reference solution scores green${ok ? "" : "  — SCENARIO UNWINNABLE"}`);
    if (!ok) for (const c of scored.checks.filter((c) => !c.pass)) console.log(`      ✗ ${c.name} — ${c.detail}`);
    cleanup(dir);
  }
}

console.log(`\n${failures === 0 ? "SELFTEST PASS" : `SELFTEST FAIL — ${failures} problem(s)`}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Eval CLI — `tsx src/agent-loop/eval/cli.ts <fixture.json | dir>`.
 *
 * Modes:
 *   - File: runs one fixture, prints the result.
 *   - Dir:  globs *.json under the dir, runs all, prints a summary table
 *           and exits non-zero if any fixture failed.
 *
 * Pure dev tooling — never imported by the server.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Fixture, RunResult } from "./types.js";
import { runFixture } from "./runner.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function loadFixture(path: string): Fixture {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as Fixture;
  if (!data.name || !data.input || !data.responses || !data.expect) {
    throw new Error(`Invalid fixture (missing required fields): ${path}`);
  }
  return data;
}

function printResult(fixture: Fixture, res: RunResult): void {
  const ok = res.assertionFailure === null;
  const tag = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const head = `${BOLD}${tag}${RESET}  ${fixture.name}  ${DIM}(${res.iterations} iter, ${res.durationMs}ms, ${res.toolCallsObserved.length} tool calls)${RESET}`;
  console.log(head);
  if (fixture.description) console.log(`      ${DIM}${fixture.description}${RESET}`);
  if (!ok) {
    console.log(`      ${RED}${res.assertionFailure}${RESET}`);
    console.log(`      ${DIM}stop=${res.turn.stopReason}  err=${res.turn.errorMessage || "—"}${RESET}`);
    if (res.toolCallsObserved.length > 0) {
      const calls = res.toolCallsObserved.map(t => t.name).join(", ");
      console.log(`      ${DIM}tools observed: ${calls}${RESET}`);
    }
  }
}

async function runOne(path: string): Promise<boolean> {
  const fixture = loadFixture(path);
  const res = await runFixture(fixture);
  printResult(fixture, res);
  return res.assertionFailure === null;
}

async function runDir(dir: string): Promise<{ pass: number; fail: number }> {
  const entries = readdirSync(dir).filter(n => n.endsWith(".json")).sort();
  if (entries.length === 0) {
    console.log(`${YELLOW}no fixtures found in ${dir}${RESET}`);
    return { pass: 0, fail: 0 };
  }
  console.log(`${BOLD}eval${RESET}  ${dir}  ${DIM}(${entries.length} fixtures)${RESET}`);
  console.log("");
  let pass = 0, fail = 0;
  for (const name of entries) {
    const ok = await runOne(join(dir, name));
    if (ok) pass++; else fail++;
  }
  console.log("");
  const summary = fail === 0
    ? `${GREEN}${BOLD}all green${RESET}  (${pass}/${entries.length})`
    : `${RED}${BOLD}${fail} failing${RESET}  ${GREEN}${pass} passing${RESET}  /${entries.length}`;
  console.log(summary);
  return { pass, fail };
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error(`usage: tsx src/agent-loop/eval/cli.ts <fixture.json | fixtures-dir>`);
    process.exit(2);
  }
  const abs = resolve(target);
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    const { fail } = await runDir(abs);
    process.exit(fail === 0 ? 0 : 1);
  }
  const ok = await runOne(abs);
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error(`${RED}eval crashed:${RESET}`, e);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * Test whether `claude -p` can run as multiple concurrent subprocesses
 * sharing the same OAuth token, without rate-limit / session conflict.
 *
 * Why this matters: the worker-pool design for Local Agent X assumes each
 * worker can spawn its own `claude -p` instance. If Anthropic's CLI
 * serializes per-token or rate-limits aggressively, we need a different
 * pattern for OAuth users (single CLI worker for Anthropic, parallel HTTP
 * workers for everything else).
 *
 * Spawns N=3 concurrent claude -p calls with a trivial prompt, times them,
 * reports exit codes + outputs. Costs ~3-5 cents.
 *
 * Run: node scripts/test-claude-cli-concurrency.mjs
 */

import { spawn } from "node:child_process";

const N = 3;
const TIMEOUT_MS = 60_000;
const PROMPT = "Reply with exactly one word: ready";

function runOne(idx) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", [
      "-p",
      "--model", "claude-haiku-4-5",   // cheap; we don't need quality
      "--no-session-persistence",
      "--output-format", "text",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, TIMEOUT_MS);
    proc.stdout?.on("data", c => { stdout += c.toString(); });
    proc.stderr?.on("data", c => { stderr += c.toString(); });
    proc.on("error", e => {
      clearTimeout(timer);
      resolve({ idx, ok: false, durationMs: Date.now() - start, error: e.message, stdout: "", stderr: "" });
    });
    proc.on("close", code => {
      clearTimeout(timer);
      resolve({
        idx,
        ok: code === 0 && stdout.trim().length > 0,
        durationMs: Date.now() - start,
        exitCode: code,
        stdout: stdout.trim().slice(0, 200),
        stderr: stderr.trim().slice(0, 500),
      });
    });
    proc.stdin?.write(PROMPT);
    proc.stdin?.end();
  });
}

console.log(`Spawning ${N} concurrent claude -p subprocesses...\n`);
const start = Date.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i + 1)));
const totalMs = Date.now() - start;

console.log("\n=== RESULTS ===");
for (const r of results) {
  console.log(`\n[#${r.idx}] ${r.ok ? "OK" : "FAIL"} in ${r.durationMs}ms (exit=${r.exitCode ?? "?"})`);
  console.log(`  stdout: ${r.stdout || "(empty)"}`);
  if (r.stderr) console.log(`  stderr: ${r.stderr.slice(0, 300)}`);
  if (r.error) console.log(`  error:  ${r.error}`);
}

const passed = results.filter(r => r.ok).length;
const allParallel = results.every(r => r.durationMs < totalMs * 1.2);
console.log(`\n=== VERDICT ===`);
console.log(`Passed: ${passed}/${N}`);
console.log(`Total wall time: ${totalMs}ms`);
console.log(`Avg per-call:    ${Math.round(results.reduce((s, r) => s + r.durationMs, 0) / N)}ms`);
console.log(`Ran in parallel: ${allParallel ? "YES (worker pool design works)" : "NO (calls were serialized)"}`);
if (passed < N) {
  console.log(`\n[!] ${N - passed} call(s) failed — multi-subprocess may have conflicts.`);
  console.log(`    Look at stderr above for rate-limit / auth errors.`);
}

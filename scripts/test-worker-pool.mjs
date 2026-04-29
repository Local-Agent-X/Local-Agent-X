#!/usr/bin/env node
/**
 * Smoke test for the worker pool (Step 1 of the supervisor architecture).
 *
 * Spawns the pool, submits one trivial op, waits for completion, verifies
 * artifacts on disk (operation.json, events.jsonl, checkpoint.json).
 *
 * Run: npx tsx scripts/test-worker-pool.mjs
 *
 * Costs: ~1 cent (one trivial chat call to whatever provider resolveProvider picks).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const { startWorkerPool, submitOp, getPoolStatus } = await import("../src/workers/pool.ts");

console.log("=== Worker Pool Smoke Test ===\n");

console.log("[1] starting pool...");
startWorkerPool();

// Give the worker a beat to come up + announce ready
await new Promise(r => setTimeout(r, 3000));

console.log(`    pool status: ${JSON.stringify(getPoolStatus(), null, 2)}\n`);

const opId = `op_smoke_${Date.now().toString(36)}`;

console.log(`[2] submitting op ${opId}...`);
const op = {
  id: opId,
  type: "smoke-test",
  task: "Reply with the word 'pong' and nothing else.",
  contextPack: {
    task: {
      description: "Reply with the word 'pong' and nothing else.",
      successCriteria: ["Output is a single word: 'pong'"],
      constraints: ["Do not call any tools.", "Do not say anything else."],
      notWhatToRedo: [],
    },
    context: {
      recentTurns: [],
      referencedFiles: [],
      memoryHits: [],
      agentsRules: "",
    },
    capabilities: { needsTools: false, needsStreaming: true },
    budget: { maxIterations: 2, maxTokens: 100, maxWallTimeMs: 60000, maxSelfEditCalls: 0 },
    routing: { lane: "background" },
    secrets: { allowed: [] },
  },
  lane: "background",
  retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [1000] },
  ownerId: "smoke-test",
  visibility: "private",
  status: "pending",
  createdAt: new Date().toISOString(),
  attemptCount: 0,
};

const startMs = Date.now();
const result = await submitOp(op);
const wallMs = Date.now() - startMs;

console.log(`\n[3] result returned in ${wallMs}ms:`);
console.log(JSON.stringify(result, null, 2));

console.log("\n[4] verifying disk artifacts...");
const opDir = join(homedir(), ".lax", "operations", opId);
const checks = [
  { path: join(opDir, "operation.json"), label: "operation.json" },
  { path: join(opDir, "events.jsonl"), label: "events.jsonl" },
  { path: join(opDir, "checkpoint.json"), label: "checkpoint.json" },
];
let allPresent = true;
for (const c of checks) {
  if (existsSync(c.path)) {
    const size = readFileSync(c.path, "utf-8").length;
    console.log(`    [OK] ${c.label} (${size} bytes)`);
  } else {
    console.log(`    [MISSING] ${c.label} at ${c.path}`);
    allPresent = false;
  }
}

console.log("\n[5] events.jsonl content:");
const eventsPath = join(opDir, "events.jsonl");
if (existsSync(eventsPath)) {
  const lines = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const e = JSON.parse(line);
    const summary = e.payload?.delta || e.payload?.summary || e.payload?.phase || JSON.stringify(e.payload).slice(0, 80);
    console.log(`    [${e.type}] ${summary}`);
  }
}

console.log("\n=== VERDICT ===");
const ok = result.status === "completed" && allPresent;
console.log(ok ? "PASS — worker pool foundation works end-to-end" : "FAIL — see above");
process.exit(ok ? 0 : 1);

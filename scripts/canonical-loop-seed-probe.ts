/**
 * Single-op probe: submits a canonical-routed interactive op with a unique
 * task phrase, waits for terminal, prints the on-disk op-messages.jsonl
 * + the assistant response, and asserts:
 *   - first row is role=user
 *   - first row contains the unique phrase (proves seeding fix)
 *   - assistant response references the phrase (proves model received it)
 *
 * Run:  LAX_CANONICAL_LOOP_INTERACTIVE=1 npx tsx scripts/canonical-loop-seed-probe.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  decideSubmitRouting,
  canonicalLoopEntry,
  awaitIdle,
  readOpMessages,
} from "../src/canonical-loop/index.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { buildContextPack } from "../src/ops/context-pack-builder.js";
import { getRetryPolicy } from "../src/ops/heartbeat.js";
import type { Op, OpVisibility } from "../src/ops/types.js";

const UNIQUE_PHRASE = "CANONICAL_SEED_OK_123";
const TASK = `Reply with exactly: ${UNIQUE_PHRASE}.`;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function awaitTerminal(opId: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return s;
    await sleep(100);
  }
  return "timeout";
}

async function main(): Promise<void> {
  if (process.env.LAX_CANONICAL_LOOP_INTERACTIVE !== "1") {
    console.error("LAX_CANONICAL_LOOP_INTERACTIVE=1 required");
    process.exit(2);
  }
  bootstrapCanonicalLoop();

  const contextPack = await buildContextPack({
    description: TASK,
    successCriteria: [`Reply contains the literal token ${UNIQUE_PHRASE}`],
    constraints: [],
    notWhatToRedo: [],
    referencedFilePaths: [],
    lane: "interactive",
    budget: { maxIterations: 5, maxWallTimeMs: 60_000 },
  });
  const op: Op = {
    id: newOpId("op_freeform_seedprobe"),
    type: "freeform",
    task: TASK,
    contextPack,
    lane: "interactive",
    retryPolicy: getRetryPolicy("freeform"),
    ownerId: "seed-probe",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  const routing = decideSubmitRouting(op);
  if (routing.route !== "canonical") {
    console.error(`FATAL: op routed to "${routing.route}" — flag misconfigured`);
    process.exit(2);
  }

  console.log(`opId: ${op.id}`);
  canonicalLoopEntry(op);

  const finalState = await awaitTerminal(op.id);
  await awaitIdle(5_000).catch(() => undefined);

  console.log(`final state: ${finalState}`);

  const opsBase = join(homedir(), ".lax", "operations");
  const msgsPath = join(opsBase, op.id, "op-messages.jsonl");
  if (!existsSync(msgsPath)) {
    console.error("op-messages.jsonl missing");
    process.exit(1);
  }
  const lines = readFileSync(msgsPath, "utf8").trim().split("\n");
  console.log(`\n=== op-messages.jsonl (${lines.length} rows) ===`);
  for (const line of lines) {
    const j = JSON.parse(line);
    const text = (j.content?.text ?? JSON.stringify(j.content)).slice(0, 400);
    console.log(`  [${j.role.padEnd(10)} turn=${j.turnIdx} seq=${j.seqInTurn}]  ${text}`);
  }

  const msgs = readOpMessages(op.id);
  const first = msgs[0];
  const firstText = (first?.content as { text?: string } | null)?.text ?? "";
  const assistant = msgs.find(m => m.role === "assistant");
  const assistantText = (assistant?.content as { text?: string } | null)?.text ?? "";

  console.log("\n=== invariants ===");
  const checks = [
    ["first row role === user", first?.role === "user"],
    [`first row contains "${UNIQUE_PHRASE}"`, firstText.includes(UNIQUE_PHRASE)],
    ["assistant row exists", !!assistant],
    [`assistant response includes "${UNIQUE_PHRASE}"`, assistantText.includes(UNIQUE_PHRASE)],
    ["final state === succeeded", finalState === "succeeded"],
  ] as const;
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nSEED PROBE PASSED" : "\nSEED PROBE FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error("probe crashed:", e); process.exit(2); });

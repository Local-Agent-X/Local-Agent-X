/**
 * Production-path canary smoke. Proves the bootstrap default-adapter
 * registration drives a real Anthropic-backed op end-to-end with NO
 * per-op `registerAdapterForOp` cheat — exactly the path live canary
 * traffic takes after `bootstrapCanonicalLoop()` runs at server start.
 *
 *   1. Set the canonical flag for interactive lane.
 *   2. Call bootstrapCanonicalLoop() — registers AnthropicAdapter as the
 *      lane default. This is what server/index.ts does at startup.
 *   3. Submit a tiny op through canonicalLoopEntry (no per-op factory).
 *   4. Wait for terminal. Expect succeeded with the real Anthropic
 *      adapter's provider_state envelope (adapterName === "anthropic").
 *
 * This is a LIVE Anthropic call — needs OAuth available. If auth is
 * not configured, the adapter surfaces an error report and the op
 * lands at `failed`, which the script will report (not crash).
 *
 * Run: npx tsx scripts/canonical-loop-production-canary-smoke.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  setLeaseConfig,
  awaitIdle,
  readCanonicalEvents,
  readLatestOpTurn,
  resolveAdapterFactory,
  ANTHROPIC_ADAPTER_NAME,
} from "../src/canonical-loop/index.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function awaitTerminal(opId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    await sleep(100);
  }
  throw new Error(`op ${opId} did not terminate`);
}

async function main(): Promise<void> {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 60_000, heartbeatIntervalMs: 10_000 });

  // The thing under test.
  bootstrapCanonicalLoop();

  const op: Op = {
    id: newOpId("canary_prod_path"),
    type: "freeform",
    task: "Reply with exactly: ok.",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
    ownerId: "canary-prod-smoke",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  // PROOF point #1: bootstrap registered a factory for the interactive lane
  // and resolveAdapterFactory finds it for an op WITHOUT a per-op registration.
  const factory = resolveAdapterFactory(op);
  if (!factory) {
    console.error("FAIL: no adapter factory resolved for interactive lane after bootstrap");
    process.exit(1);
  }
  const adapterProbe = await factory();
  if (adapterProbe.name !== ANTHROPIC_ADAPTER_NAME) {
    console.error(`FAIL: bootstrap registered adapter "${adapterProbe.name}", expected "${ANTHROPIC_ADAPTER_NAME}"`);
    process.exit(1);
  }
  console.log(`bootstrap factory check: AnthropicAdapter (name=${adapterProbe.name}, version=${adapterProbe.version})`);

  console.log(`opId: ${op.id}`);
  console.log("submitting via canonicalLoopEntry (no per-op factory)...");
  canonicalLoopEntry(op);

  await awaitTerminal(op.id);
  await awaitIdle(5_000).catch(() => undefined);

  const final = readOp(op.id);
  const events = readCanonicalEvents(op.id);
  const turn0 = readLatestOpTurn(op.id);

  console.log(`\nfinal state: ${final?.canonical?.state}`);
  console.log(`events: ${events.length}`);
  console.log(`op_turns committed: ${turn0 ? turn0.turnIdx + 1 : 0}`);

  console.log(`\n=== canonical-events.jsonl ===`);
  for (const e of events) {
    const body = e.type === "message_appended" || e.type === "turn_started" || e.type === "turn_committed"
      ? JSON.stringify(e.body)
      : JSON.stringify(e.body);
    console.log(`seq=${String(e.seq).padStart(2, " ")}  ${e.type.padEnd(20)} ${body}`);
  }

  if (turn0) {
    console.log(`\nprovider_state.adapterName: ${turn0.providerState.adapterName}`);
    console.log(`provider_state.adapterVersion: ${turn0.providerState.adapterVersion}`);
    console.log(`provider_state.providerPayload: ${JSON.stringify(turn0.providerState.providerPayload)}`);
  }

  // Hard invariants for production-path success.
  const okState = final?.canonical?.state === "succeeded";
  const okFlag = final?.canonical?.flagValue === true;
  const adapterName = turn0?.providerState.adapterName;
  const okAdapter = adapterName === ANTHROPIC_ADAPTER_NAME;
  const okSeq = events.every((e, i) => e.seq === i);
  const okTerminal = events.filter(e =>
    e.type === "state_changed" && (e.body as { to: string }).to === "succeeded",
  ).length === 1;

  console.log(`\n=== invariants ===`);
  for (const [name, pass] of [
    ["final state === succeeded (real Anthropic round-trip)", okState],
    ["op.canonical.flagValue === true", okFlag],
    [`provider_state.adapterName === "${ANTHROPIC_ADAPTER_NAME}" (proves bootstrap factory served the op)`, okAdapter],
    ["per-op seq monotonic 0..N", okSeq],
    ["exactly one terminal state_changed", okTerminal],
  ] as const) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  }
  const allPass = okState && okFlag && okAdapter && okSeq && okTerminal;
  console.log(allPass ? "\nPRODUCTION PATH GREEN" : "\nPRODUCTION PATH FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error("smoke failed:", e); process.exit(2); });

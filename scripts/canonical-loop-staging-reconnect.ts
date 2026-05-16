/**
 * Staging exercise: canonical-loop client disconnect / reconnect-replay.
 *
 * Submits a real op through the canonical seam, subscribes to its event
 * channel, "disconnects" mid-op (unsubscribe), then "reconnects" via
 * reconnectOp(opId, lastSeq, listener). Verifies that the reconnect
 * listener receives every event from seq=N+1..M in order with no
 * duplicates and no gaps.
 *
 * Run: npx tsx scripts/canonical-loop-staging-reconnect.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalLoopEntry,
  registerAdapterForOp,
  setLeaseConfig,
  awaitIdle,
  readCanonicalEvents,
  reconnectOp,
  subscribeOpEvents,
  OP_EVENTS_FROM_BEGINNING,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { FakeAdapter, scriptTurn, scriptLongStreamingTurn } from "../test/canonical-loop/fake-adapter.js";
import type { Op } from "../src/ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");

function readOperationJson(opId: string): unknown {
  const p = join(OPS_BASE, opId, "operation.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function awaitTerminal(opId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return;
    await sleep(10);
  }
  throw new Error(`op ${opId} did not terminate`);
}

async function main(): Promise<void> {
  process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
  setLeaseConfig({ leaseDurationMs: 30_000, heartbeatIntervalMs: 5_000 });

  const op: Op = {
    id: newOpId("staging_reconnect"),
    type: "freeform",
    task: "staging client reconnect / op_events_since",
    contextPack: {} as Op["contextPack"],
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5000] },
    ownerId: "staging-exercise",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  // 3 turns: fast turn 0, long-streaming turn 1 (~3s), fast terminal turn 2.
  // Long turn 1 gives us ample window to disconnect and let the worker
  // accumulate events on disk while we're "offline".
  registerAdapterForOp(op.id, () => new FakeAdapter({
    script: [
      scriptTurn({ text: "turn 0", terminal: undefined }),
      scriptLongStreamingTurn({ chunkIntervalMs: 30, maxChunks: 100 }),
      scriptTurn({ text: "turn 2 final", terminal: "done" }),
    ],
  }));

  console.log(`opId: ${op.id}`);
  console.log("─".repeat(72));

  // ── PHASE 1: client subscribes BEFORE submit (live tail) ────────────────
  const liveEvents: CanonicalEvent[] = [];
  const off1 = subscribeOpEvents(op.id, e => { liveEvents.push(e); });

  canonicalLoopEntry(op);

  // Wait until we've accumulated some events live, then disconnect.
  // Target ~6 events (state_changed, lease_acquired, state_changed,
  // turn_started, message_appended, turn_committed for turn 0 + a few
  // into turn 1 if we're slow).
  const phase1Deadline = Date.now() + 1500;
  while (Date.now() < phase1Deadline) {
    if (liveEvents.length >= 6) break;
    await sleep(15);
  }

  const lastSeqBeforeReconnect = liveEvents[liveEvents.length - 1]?.seq ?? -1;
  off1();
  console.log(`\n>>> client disconnected after seq=${lastSeqBeforeReconnect}`);
  console.log(`    received live events while connected:`);
  for (const e of liveEvents) {
    console.log(`      seq=${String(e.seq).padStart(2, " ")}  ${e.type}`);
  }

  // ── PHASE 2: op continues running while client is "offline" ─────────────
  // Sleep so the worker has time to commit more events with no listener.
  await sleep(800);

  const onDiskMidGap = readCanonicalEvents(op.id);
  console.log(`\n>>> while disconnected, disk grew to ${onDiskMidGap.length} events (last seq=${onDiskMidGap[onDiskMidGap.length - 1]?.seq})`);

  // ── PHASE 3: reconnect via reconnectOp ──────────────────────────────────
  const reconnectEvents: CanonicalEvent[] = [];
  const reconnectResult = reconnectOp(op.id, lastSeqBeforeReconnect, e => {
    reconnectEvents.push(e);
  });
  if (!reconnectResult.ok) {
    console.error(`reconnectOp failed: ${reconnectResult.code} — ${reconnectResult.message}`);
    process.exit(2);
  }
  console.log(`\n>>> reconnected at sinceSeq=${lastSeqBeforeReconnect}`);
  console.log(`    latestReplayedSeq=${reconnectResult.latestReplayedSeq}`);

  // Let the op finish — reconnect listener should keep receiving live events
  // through the bus subscription part of reconnectOp.
  await awaitTerminal(op.id);
  await awaitIdle(2000).catch(() => undefined);
  reconnectResult.off();

  // ── Audit ────────────────────────────────────────────────────────────────
  const finalDisk = readCanonicalEvents(op.id);
  const finalState = (readOperationJson(op.id) as { canonical?: { state?: string } })?.canonical?.state;

  console.log(`\n=== events received via reconnect (${reconnectEvents.length}) ===`);
  for (const e of reconnectEvents) {
    console.log(`  seq=${String(e.seq).padStart(2, " ")}  ${e.type.padEnd(20)} ${JSON.stringify(e.body)}`);
  }

  console.log(`\n=== summary ===`);
  console.log(`opId:                       ${op.id}`);
  console.log(`last seq before reconnect:  ${lastSeqBeforeReconnect}`);
  console.log(`reconnect events count:     ${reconnectEvents.length}`);
  console.log(`reconnect first seq:        ${reconnectEvents[0]?.seq ?? "-"}`);
  console.log(`reconnect last seq:         ${reconnectEvents[reconnectEvents.length - 1]?.seq ?? "-"}`);
  console.log(`disk total events:          ${finalDisk.length} (last seq=${finalDisk[finalDisk.length - 1].seq})`);
  console.log(`final state:                ${finalState}`);

  // Invariants the PRD §12 reconnect protocol guarantees.
  const expectedSeqs = finalDisk.filter(e => e.seq > lastSeqBeforeReconnect).map(e => e.seq);
  const receivedSeqs = reconnectEvents.map(e => e.seq);
  const monotonic = receivedSeqs.every((s, i) => i === 0 || s > receivedSeqs[i - 1]);
  const noDupes = new Set(receivedSeqs).size === receivedSeqs.length;
  const allAfterCutoff = receivedSeqs.every(s => s > lastSeqBeforeReconnect);
  const coversGap = receivedSeqs.length === expectedSeqs.length && receivedSeqs.every((s, i) => s === expectedSeqs[i]);

  // Sanity: a "client UI" walking from BEGINNING and applying events one by
  // one should end at the same state as the disk's terminal state.
  const fromScratch = (() => {
    const r: { ok: boolean; events: CanonicalEvent[]; latestReplayedSeq: number | null; off: () => void } | { ok: false; code: string; message: string } = reconnectOp(op.id, OP_EVENTS_FROM_BEGINNING, () => undefined);
    if (!r.ok) return null;
    r.off();
    return r.latestReplayedSeq;
  })();

  const assertions = [
    ["reconnect events monotonic", monotonic],
    ["reconnect events have no duplicates", noDupes],
    ["all reconnect events have seq > lastSeqBeforeReconnect", allAfterCutoff],
    [`reconnect covered the gap exactly (${expectedSeqs.length} expected, ${receivedSeqs.length} received)`, coversGap],
    [`final state === succeeded`, finalState === "succeeded"],
    [`from-scratch reconnect lands at last disk seq (${fromScratch} == ${finalDisk[finalDisk.length - 1].seq})`, fromScratch === finalDisk[finalDisk.length - 1].seq],
  ] as const;

  console.log(`\n=== invariants ===`);
  let ok = true;
  for (const [name, pass] of assertions) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "\nALL INVARIANTS PASS" : "\nSOME INVARIANTS FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error("staging exercise failed:", e);
  process.exit(2);
});

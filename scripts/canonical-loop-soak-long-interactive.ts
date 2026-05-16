/**
 * Long-lived interactive-lane soak for canonical-loop v1.0.
 *
 * Validates the loop under prompts that produce 60–180 second real
 * Anthropic streaming responses (no tools, no web), exercising:
 *   - Mid-flight `op_events_since(opId, N)` reconnect-replay (PRD §12)
 *   - Live bus tail continuing past replay with monotonic seq
 *   - Long-lived lease (heartbeats spanning 60+s)
 *   - Provider_state envelope across multi-second turn
 *   - Real content/response events arriving spread across wall time
 *
 * Same production submit + routing path as `op_submit_async`:
 *   buildContextPack + getRetryPolicy → decideSubmitRouting →
 *   canonicalLoopEntry. Default Anthropic adapter via
 *   `bootstrapCanonicalLoop()` — no test-only `registerAdapterForOp`.
 *
 * Modes:
 *   default               run --count long ops (default 3) sequentially
 *   --cancel-one          run one long op, cancel mid-stream via opCancel
 *
 *   Usage (PowerShell):
 *     $env:LAX_CANONICAL_LOOP_INTERACTIVE=1
 *     npx tsx scripts/canonical-loop-soak-long-interactive.ts --count 3
 *     npx tsx scripts/canonical-loop-soak-long-interactive.ts --count 1 --cancel-one
 *
 *   Usage (bash):
 *     LAX_CANONICAL_LOOP_INTERACTIVE=1 npx tsx scripts/canonical-loop-soak-long-interactive.ts --count 3
 *
 * Exits 0 if all invariants pass, 1 on invariant breach, 2 on script
 * crash (auth/bootstrap missing).
 */
import {
  decideSubmitRouting,
  canonicalLoopEntry,
  awaitIdle,
  readCanonicalEvents,
  readLatestOpTurn,
  opEventsSince,
  subscribeOpEvents,
  subscribeOpStream,
  opCancel,
  resolveAdapterFactory,
  ANTHROPIC_ADAPTER_NAME,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
  type CanonicalEvent,
} from "../src/canonical-loop/index.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { buildContextPack } from "../src/ops/context-pack-builder.js";
import { getRetryPolicy } from "../src/ops/heartbeat.js";
import type { Op, OpVisibility } from "../src/ops/types.js";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface SoakConfig {
  count: number;
  cancelOne: boolean;
  perOpTimeoutMs: number;
  cancelAfterMs: number;
}

function parseConfig(): SoakConfig {
  const argv = process.argv.slice(2);
  let count = parseInt(process.env.LAX_SOAK_COUNT ?? "3", 10);
  let perOpTimeoutMs = parseInt(process.env.LAX_SOAK_TIMEOUT_MS ?? "240000", 10);
  let cancelAfterMs = parseInt(process.env.LAX_SOAK_CANCEL_AFTER_MS ?? "8000", 10);
  let cancelOne = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count" && argv[i + 1]) { count = parseInt(argv[i + 1], 10); i++; }
    else if (argv[i] === "--timeout-ms" && argv[i + 1]) { perOpTimeoutMs = parseInt(argv[i + 1], 10); i++; }
    else if (argv[i] === "--cancel-after-ms" && argv[i + 1]) { cancelAfterMs = parseInt(argv[i + 1], 10); i++; }
    else if (argv[i] === "--cancel-one") { cancelOne = true; }
  }
  if (!Number.isFinite(count) || count < 1) count = 3;
  if (!Number.isFinite(perOpTimeoutMs) || perOpTimeoutMs < 30_000) perOpTimeoutMs = 240_000;
  if (!Number.isFinite(cancelAfterMs) || cancelAfterMs < 1_000) cancelAfterMs = 8_000;
  return { count, cancelOne, perOpTimeoutMs, cancelAfterMs };
}

// Prompts crafted to produce 60–180s of real streaming output without
// requiring tools / web / browser. Each asks for a long, dense narrative
// or explanation. The model will stream tokens for well over a minute.
const LONG_PROMPTS: readonly string[] = [
  "Write a detailed 1500-word fictional short story about a lighthouse keeper on a remote island who discovers a hidden room beneath the lighthouse. Include vivid sensory descriptions, internal monologue, and at least three distinct scenes. Make every paragraph contribute to atmosphere or character.",
  "Explain in comprehensive technical detail how an internal combustion engine works, from the moment fuel enters the cylinder to the moment exhaust leaves it. Cover the four-stroke cycle, valve timing, ignition, fuel injection, cooling, lubrication, and emissions control. Aim for 1500+ words and treat each subsystem in its own section.",
  "Write a 1500-word essay analyzing the architectural patterns of a modern distributed microservices system. Cover service discovery, circuit breakers, distributed tracing, event-driven communication, eventual consistency, the saga pattern, sidecar proxies, and observability. For each topic include the problem it solves, common implementations, and tradeoffs.",
  "Write a detailed 1500-word historical narrative about the construction of the transcontinental railroad in 19th century America. Cover the labor force, engineering challenges, financing, political dynamics, treatment of Chinese and Irish workers, and the social impact on Native American populations. Use vivid scene-setting and concrete details throughout.",
  "Write a comprehensive 1500-word piece on how human memory works at the neurological and psychological level. Cover sensory, short-term, working, and long-term memory; hippocampal consolidation; the role of sleep; semantic vs episodic memory; the reconstructive nature of recall; and common failure modes like confabulation and memory decay. Treat each section in depth.",
];

async function buildLongOp(idx: number): Promise<Op> {
  const task = LONG_PROMPTS[idx % LONG_PROMPTS.length];
  const opType = "freeform";
  const lane = "interactive" as const;
  const contextPack = await buildContextPack({
    description: task,
    successCriteria: [],
    constraints: [],
    notWhatToRedo: [],
    referencedFilePaths: [],
    lane,
    budget: { maxIterations: 5, maxWallTimeMs: 300_000 },
  });
  return {
    id: newOpId(`op_${opType}_longsoak`),
    type: opType,
    task,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "canonical-loop-long-soak",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

interface EventTrace {
  events: CanonicalEvent[];
  streamChunkCount: number;
  firstStreamChunkAt: number | null;
  firstMessageAppendedAt: number | null;
  lastEventAt: number | null;
  lastStreamChunkAt: number | null;
  off: () => void;
  offStream: () => void;
}

function startEventTrace(opId: string): EventTrace {
  const trace: EventTrace = {
    events: [],
    streamChunkCount: 0,
    firstStreamChunkAt: null,
    firstMessageAppendedAt: null,
    lastEventAt: null,
    lastStreamChunkAt: null,
    off: () => undefined,
    offStream: () => undefined,
  };
  trace.off = subscribeOpEvents(opId, e => {
    trace.events.push(e);
    trace.lastEventAt = Date.now();
    if (e.type === "message_appended" && trace.firstMessageAppendedAt === null) {
      trace.firstMessageAppendedAt = Date.now();
    }
  });
  trace.offStream = subscribeOpStream(opId, () => {
    trace.streamChunkCount++;
    trace.lastStreamChunkAt = Date.now();
    if (trace.firstStreamChunkAt === null) trace.firstStreamChunkAt = Date.now();
  });
  return trace;
}

async function awaitTerminal(opId: string, timeoutMs: number): Promise<"succeeded" | "failed" | "cancelled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return s;
    await sleep(200);
  }
  return "timeout";
}

async function awaitFirstContent(trace: EventTrace, timeoutMs = 60_000): Promise<boolean> {
  // Wait specifically for the FIRST stream chunk from the model (real
  // adapter output), NOT just any message_appended — the seeded user
  // message_appended fires synchronously at submit and would race the
  // replay check past the actual streaming window.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (trace.firstStreamChunkAt !== null) return true;
    await sleep(100);
  }
  return false;
}

interface OpResult {
  opId: string;
  finalState: string;
  durationMs: number;
  invariants: { name: string; pass: boolean }[];
  failedInvariants: string[];
  hasAdapterError: boolean;
  hasReplayGap: boolean;
  hasDuplicateTerminal: boolean;
  providerStateOk: boolean;
  opTurnsCount: number;
  contentSpannedMs: number | null;
  // Replay-specific
  replayCutoffSeq: number | null;
  replayReturnedCount: number;
  replayLiveTailContinued: boolean;
}

interface CheckOpInput {
  opId: string;
  finalState: string;
  durationMs: number;
  trace: EventTrace;
  expectSucceeded: boolean;
}

function checkOp({ opId, finalState, durationMs, trace, expectSucceeded }: CheckOpInput): OpResult {
  const op = readOp(opId);
  const events = readCanonicalEvents(opId);
  const latestTurn = readLatestOpTurn(opId);

  const adapterErrors = events.filter(e => e.type === "error" && (e.body as { code?: string })?.code === "adapter_error");
  const stateChanges = events.filter(e => e.type === "state_changed");
  const terminalChanges = stateChanges.filter(e => {
    const to = (e.body as { to?: string })?.to;
    return to === "succeeded" || to === "failed" || to === "cancelled";
  });

  // provider_state check (only meaningful when a turn committed; cancelled
  // mid-stream legitimately commits zero turns).
  let providerStateOk = true;
  let opTurnsCount = 0;
  if (latestTurn) {
    opTurnsCount = latestTurn.turnIdx + 1;
    const psSize = Buffer.byteLength(JSON.stringify(latestTurn.providerState), "utf8");
    if (psSize > PROVIDER_STATE_MAX_BYTES_DEFAULT) providerStateOk = false;
    if (latestTurn.providerState?.adapterName !== ANTHROPIC_ADAPTER_NAME) providerStateOk = false;
  } else if (expectSucceeded) {
    providerStateOk = false;
  }

  const leaseCleared = (op?.canonical?.leaseOwner ?? null) === null
    && (op?.canonical?.leaseExpiresAt ?? null) === null;

  // "Content spanned across time" — first stream chunk to first message
  // finalize, OR first chunk to terminal. Long ops should show seconds-
  // wide spread, not 0ms (which would mean the response landed all at once).
  let contentSpannedMs: number | null = null;
  if (trace.firstStreamChunkAt !== null && trace.lastEventAt !== null) {
    contentSpannedMs = trace.lastEventAt - trace.firstStreamChunkAt;
  }

  const expectedState = expectSucceeded ? "succeeded" : "cancelled";
  const seqGaps: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i].seq !== i) seqGaps.push(i);

  const invariants: { name: string; pass: boolean }[] = [
    { name: `final state === ${expectedState}`, pass: finalState === expectedState },
    { name: "exactly one terminal state_changed", pass: terminalChanges.length === 1 },
    { name: "no adapter_error events", pass: adapterErrors.length === 0 },
    { name: "no stuck running (terminal reached within timeout)", pass: finalState !== "timeout" },
    { name: "per-op seq monotonic 0..N (no gaps)", pass: seqGaps.length === 0 },
    { name: "leaseOwner / leaseExpiresAt cleared at terminal", pass: leaseCleared },
    { name: "op.canonical.flagValue === true", pass: op?.canonical?.flagValue === true },
    { name: "provider_state OK (adapter matches + within cap)", pass: providerStateOk },
  ];
  if (expectSucceeded) {
    invariants.push({ name: "op_turns >= 1", pass: opTurnsCount >= 1 });
    invariants.push({
      name: "content events spread across time (>=3000ms span)",
      pass: contentSpannedMs !== null && contentSpannedMs >= 3000,
    });
  } else {
    // Cancelled: no committed turn is fine (PRD §13: discard partial turn).
    invariants.push({ name: "no committed turn for cancelled op (partial discarded)", pass: opTurnsCount === 0 });
  }

  const failed = invariants.filter(i => !i.pass).map(i => i.name);

  return {
    opId,
    finalState,
    durationMs,
    invariants,
    failedInvariants: failed,
    hasAdapterError: adapterErrors.length > 0,
    hasReplayGap: false, // set below if replay was performed
    hasDuplicateTerminal: terminalChanges.length > 1,
    providerStateOk,
    opTurnsCount,
    contentSpannedMs,
    replayCutoffSeq: null,
    replayReturnedCount: 0,
    replayLiveTailContinued: false,
  };
}

interface ReplayCheck {
  cutoffSeq: number;
  returnedCount: number;
  monotonic: boolean;
  noGaps: boolean;
  allAfterCutoff: boolean;
  liveTailContinued: boolean;
}

async function midflightReplayCheck(opId: string, trace: EventTrace): Promise<ReplayCheck> {
  // Pick a midflight seq from what we've observed live so far.
  if (trace.events.length === 0) {
    return { cutoffSeq: -1, returnedCount: 0, monotonic: true, noGaps: true, allAfterCutoff: true, liveTailContinued: false };
  }
  const cutoffSeq = trace.events[trace.events.length - 1].seq;
  // Snapshot count just before replay so we can detect live-tail growth.
  const liveCountBeforeReplay = trace.events.length;

  const result = opEventsSince(opId, cutoffSeq);
  if (!result.ok) {
    return { cutoffSeq, returnedCount: 0, monotonic: false, noGaps: false, allAfterCutoff: false, liveTailContinued: false };
  }

  const seqs = result.events.map(e => e.seq);
  const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const noGaps = result.events.length === 0 || (
    seqs[0] === cutoffSeq + 1
    && seqs[seqs.length - 1] - seqs[0] + 1 === seqs.length
  );
  const allAfterCutoff = seqs.every(s => s > cutoffSeq);

  // Live-tail check: during a long Anthropic streaming turn, canonical
  // events stay quiet between turn_started/message_appended(user seed)
  // and message_appended(assistant final) — all activity rides on
  // op_stream channel (PRD §12: stream chunks are bus-only, ephemeral).
  // "Live tail continued" = either NEW canonical events fired OR new
  // stream chunks landed in the wait window.
  const streamCountBefore = trace.streamChunkCount;
  await sleep(2000);
  const liveTailContinued = trace.events.length > liveCountBeforeReplay
    || trace.streamChunkCount > streamCountBefore;

  return { cutoffSeq, returnedCount: result.events.length, monotonic, noGaps, allAfterCutoff, liveTailContinued };
}

async function runOneOp(idx: number, total: number, cfg: SoakConfig): Promise<OpResult> {
  const op = await buildLongOp(idx);
  const routing = decideSubmitRouting(op);
  if (routing.route !== "canonical") {
    throw new Error(`op ${op.id} routed to "${routing.route}" — flag misconfigured?`);
  }

  const trace = startEventTrace(op.id);
  const startMs = Date.now();
  canonicalLoopEntry(op);

  // Wait for first content (stream chunk OR message_appended). Need this
  // before we can do the mid-flight replay check meaningfully.
  const gotContent = await awaitFirstContent(trace, 60_000);
  if (!gotContent) {
    trace.off(); trace.offStream();
    const finalState = await awaitTerminal(op.id, 5_000);
    return {
      ...checkOp({ opId: op.id, finalState, durationMs: Date.now() - startMs, trace, expectSucceeded: true }),
      replayCutoffSeq: null,
      replayReturnedCount: 0,
      replayLiveTailContinued: false,
    };
  }

  // Mid-flight replay check.
  const replay = await midflightReplayCheck(op.id, trace);

  console.log(
    `[${String(idx + 1).padStart(2, " ")}/${total}] mid-flight replay  seq>${replay.cutoffSeq}  returned=${replay.returnedCount}  ` +
    `monotonic=${replay.monotonic}  noGaps=${replay.noGaps}  allAfterCutoff=${replay.allAfterCutoff}  liveTail=${replay.liveTailContinued}`,
  );

  const finalState = await awaitTerminal(op.id, cfg.perOpTimeoutMs);
  trace.off(); trace.offStream();

  const result = checkOp({
    opId: op.id,
    finalState,
    durationMs: Date.now() - startMs,
    trace,
    expectSucceeded: true,
  });
  result.replayCutoffSeq = replay.cutoffSeq;
  result.replayReturnedCount = replay.returnedCount;
  result.replayLiveTailContinued = replay.liveTailContinued;
  result.hasReplayGap = !(replay.monotonic && replay.noGaps && replay.allAfterCutoff);

  // Add replay invariants to the per-op record.
  result.invariants.push(
    { name: "op_events_since: returned events monotonic", pass: replay.monotonic },
    { name: "op_events_since: contiguous (no gaps)", pass: replay.noGaps },
    { name: "op_events_since: all returned seq > cutoff", pass: replay.allAfterCutoff },
    { name: "live tail continued after replay", pass: replay.liveTailContinued },
  );
  result.failedInvariants = result.invariants.filter(i => !i.pass).map(i => i.name);
  return result;
}

async function buildCancelOneOp(): Promise<Op> {
  // Cancel-one prompt: a long-form descriptive piece the model will
  // actually engage with. The lighthouse keeper prompt streamed fast
  // in long-soak op #1; reuse it here and just bump the word target
  // so there's plenty of streaming runway to cancel into.
  const task = "Write a vivid 3000-word fictional short story about a lighthouse keeper on a remote island who discovers a hidden room beneath the lighthouse. Start writing the story IMMEDIATELY in the first reply — don't ask any questions, don't summarize what you're going to write, just dive into the story with the first sentence. Include vivid sensory descriptions, internal monologue, and at least five distinct scenes.";
  const opType = "freeform";
  const lane = "interactive" as const;
  const contextPack = await buildContextPack({
    description: task,
    successCriteria: [],
    constraints: [],
    notWhatToRedo: [],
    referencedFilePaths: [],
    lane,
    budget: { maxIterations: 5, maxWallTimeMs: 300_000 },
  });
  return {
    id: newOpId("op_freeform_cancelone"),
    type: opType,
    task,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "canonical-loop-cancel-one",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function runCancelOne(cfg: SoakConfig): Promise<OpResult> {
  const op = await buildCancelOneOp();
  const routing = decideSubmitRouting(op);
  if (routing.route !== "canonical") {
    throw new Error(`op ${op.id} routed to "${routing.route}" — flag misconfigured?`);
  }

  const trace = startEventTrace(op.id);
  const startMs = Date.now();
  canonicalLoopEntry(op);

  // Cancel mid-STREAM (not pre-stream). The cancel-one prompt is
  // crafted to start streaming within seconds — first token kicks off
  // the cancel race meaningfully. Pre-stream cancel hangs on the
  // Anthropic CLI subprocess waiting for first byte; that's a separate
  // adapter abort path under investigation.
  const gotStream = await awaitFirstContent(trace, 60_000);
  if (!gotStream) {
    trace.off(); trace.offStream();
    throw new Error(`cancel-one: op ${op.id} did not produce a stream chunk within 60s`);
  }

  // Let it stream a beat so we're truly mid-turn.
  await sleep(cfg.cancelAfterMs);

  console.log(`>>> cancelling op ${op.id} mid-stream (streamChunks=${trace.streamChunkCount})`);
  const ack = opCancel(op.id, "long-soak-cancel-one");
  if (!ack.ok) {
    trace.off(); trace.offStream();
    throw new Error(`opCancel returned ok=false: ${JSON.stringify(ack)}`);
  }

  const finalState = await awaitTerminal(op.id, 30_000);
  trace.off(); trace.offStream();

  return checkOp({
    opId: op.id,
    finalState,
    durationMs: Date.now() - startMs,
    trace,
    expectSucceeded: false,
  });
}

async function main(): Promise<void> {
  const cfg = parseConfig();

  if (process.env.LAX_CANONICAL_LOOP_INTERACTIVE !== "1"
      && process.env.LAX_CANONICAL_LOOP_ALL !== "1") {
    console.error("FATAL: LAX_CANONICAL_LOOP_INTERACTIVE=1 (or LAX_CANONICAL_LOOP_ALL=1) is required.");
    process.exit(2);
  }

  bootstrapCanonicalLoop();

  // Sanity: bootstrap actually registered an Anthropic factory.
  const probe = await buildLongOp(0);
  const factory = resolveAdapterFactory(probe);
  if (!factory) {
    console.error("FATAL: bootstrap registered no adapter factory for interactive lane.");
    process.exit(2);
  }
  const adapterProbe = await factory();
  if (adapterProbe.name !== ANTHROPIC_ADAPTER_NAME) {
    console.error(`FATAL: bootstrap adapter "${adapterProbe.name}" != "${ANTHROPIC_ADAPTER_NAME}"`);
    process.exit(2);
  }

  const mode = cfg.cancelOne ? "cancel-one" : `count=${cfg.count}`;
  console.log(`canonical-loop long-interactive soak — mode=${mode}`);
  console.log(`per-op timeout=${cfg.perOpTimeoutMs}ms`);
  console.log(`adapter: ${adapterProbe.name} v${adapterProbe.version}`);
  console.log("─".repeat(72));

  const results: OpResult[] = [];
  const wallStart = Date.now();

  if (cfg.cancelOne) {
    const r = await runCancelOne(cfg);
    results.push(r);
    const tag = r.failedInvariants.length === 0 ? "PASS" : "FAIL";
    console.log(
      `[cancel-one] ${tag}  ${r.opId}  state=${r.finalState}  ${r.durationMs}ms` +
      (r.failedInvariants.length > 0 ? `  ← ${r.failedInvariants.join("; ")}` : ""),
    );
  } else {
    for (let i = 0; i < cfg.count; i++) {
      const r = await runOneOp(i, cfg.count, cfg);
      results.push(r);
      const tag = r.failedInvariants.length === 0 ? "PASS" : "FAIL";
      const span = r.contentSpannedMs !== null ? `${(r.contentSpannedMs / 1000).toFixed(1)}s` : "-";
      console.log(
        `[${String(i + 1).padStart(2, " ")}/${cfg.count}] ${tag}  ${r.opId}  state=${r.finalState.padEnd(10)}  ${(r.durationMs / 1000).toFixed(1)}s  turns=${r.opTurnsCount}  contentSpan=${span}` +
        (r.failedInvariants.length > 0 ? `  ← ${r.failedInvariants.join("; ")}` : ""),
      );
    }
  }

  await awaitIdle(10_000).catch(() => undefined);
  const wallMs = Date.now() - wallStart;

  // ── Summary ────────────────────────────────────────────────────────────
  const total = results.length;
  const succeeded = results.filter(r => r.finalState === "succeeded").length;
  const cancelled = results.filter(r => r.finalState === "cancelled").length;
  const failed = results.filter(r => r.finalState === "failed").length;
  const timedOut = results.filter(r => r.finalState === "timeout").length;
  const adapterErrors = results.filter(r => r.hasAdapterError).length;
  const dupTerminals = results.filter(r => r.hasDuplicateTerminal).length;
  const replayGaps = results.filter(r => r.hasReplayGap).length;
  const providerStateBad = results.filter(r => !r.providerStateOk).length;
  const failedOps = results.filter(r => r.failedInvariants.length > 0);

  const allDur = results.map(r => r.durationMs).sort((a, b) => a - b);
  const median = allDur.length > 0 ? allDur[Math.floor(allDur.length / 2)] : null;
  const p95 = allDur.length > 0 ? allDur[Math.min(allDur.length - 1, Math.floor(allDur.length * 0.95))] : null;

  console.log("─".repeat(72));
  console.log(`=== summary (wall ${(wallMs / 1000).toFixed(1)}s) ===`);
  console.log(`total                     ${total}`);
  console.log(`succeeded                 ${succeeded}`);
  console.log(`cancelled                 ${cancelled}`);
  console.log(`failed                    ${failed}`);
  console.log(`timed out                 ${timedOut}`);
  if (median !== null) {
    console.log(`median duration           ${(median / 1000).toFixed(1)}s`);
    console.log(`p95 duration              ${(p95! / 1000).toFixed(1)}s`);
  }
  console.log(`replay gap count          ${replayGaps}`);
  console.log(`duplicate terminal count  ${dupTerminals}`);
  console.log(`adapter_error count       ${adapterErrors}`);
  console.log(`provider_state failures   ${providerStateBad}`);
  if (failedOps.length > 0) {
    console.log(`\n=== failure detail ===`);
    for (const r of failedOps) {
      console.log(`  ${r.opId}  state=${r.finalState}  failures: ${r.failedInvariants.join("; ")}`);
    }
  }

  const allPass = failedOps.length === 0;
  console.log(allPass ? "\nLONG-SOAK PASSED" : "\nLONG-SOAK FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error("long-soak crashed:", e);
  process.exit(2);
});

/**
 * Real-world interactive-lane soak for canonical-loop v1.0.
 *
 * Drives N small, real Anthropic ops through the SAME submit + routing
 * path that `op_submit_async` uses in production:
 *   1. Build an Op via `buildContextPack` + `getRetryPolicy` (mirrors
 *      `buildOpFromArgs` in src/ops/tools.ts byte-for-byte for the
 *      `interactive` lane shape).
 *   2. `decideSubmitRouting(op)` to pick legacy vs canonical (flag-driven).
 *   3. `canonicalLoopEntry(op)` if canonical — i.e., the exact line
 *      tools.ts:228 calls. The default Anthropic adapter comes from
 *      `bootstrapCanonicalLoop()` (production startup wiring).
 *
 * No `registerAdapterForOp` cheat. No FakeAdapter. No legacy fallback if
 * routing returns "legacy" — that means the flag isn't set the way the
 * soak requires, and the script will fail loudly so you know.
 *
 * Each op: short prompt (sub-second on Anthropic CLI). Default count 50.
 * Sequential (interactive lane cap=1, parallel submission would just
 * queue and serialize — soak is about volume + invariant coverage, not
 * concurrency, which Issue 11 already covers).
 *
 *   Usage (PowerShell):
 *     $env:LAX_CANONICAL_LOOP_INTERACTIVE=1
 *     npx tsx scripts/canonical-loop-soak-interactive.ts --count 50
 *
 *   Usage (bash):
 *     LAX_CANONICAL_LOOP_INTERACTIVE=1 npx tsx scripts/canonical-loop-soak-interactive.ts --count 50
 *
 *   Env-only count:
 *     LAX_CANONICAL_LOOP_INTERACTIVE=1 LAX_SOAK_COUNT=10 npx tsx scripts/canonical-loop-soak-interactive.ts
 *
 * Exits 0 if every op satisfies every invariant; 1 if any failure;
 * 2 if the script itself crashes (auth missing, bootstrap broken, etc.).
 */
import {
  decideSubmitRouting,
  canonicalLoopEntry,
  awaitIdle,
  readCanonicalEvents,
  readLatestOpTurn,
  readOpTurn,
  resolveAdapterFactory,
  ANTHROPIC_ADAPTER_NAME,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
} from "../src/canonical-loop/index.js";
import { bootstrapCanonicalLoop } from "../src/server/canonical-loop-bootstrap.js";
import { readOp, newOpId } from "../src/ops/op-store.js";
import { buildContextPack } from "../src/ops/context-pack-builder.js";
import { getRetryPolicy } from "../src/ops/heartbeat.js";
import type { Op, OpVisibility } from "../src/ops/types.js";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface SoakConfig {
  count: number;
  perOpTimeoutMs: number;
}

function parseConfig(): SoakConfig {
  const argv = process.argv.slice(2);
  let count = parseInt(process.env.LAX_SOAK_COUNT ?? "50", 10);
  let perOpTimeoutMs = parseInt(process.env.LAX_SOAK_TIMEOUT_MS ?? "60000", 10);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count" && argv[i + 1]) { count = parseInt(argv[i + 1], 10); i++; }
    else if (argv[i] === "--timeout-ms" && argv[i + 1]) { perOpTimeoutMs = parseInt(argv[i + 1], 10); i++; }
  }
  if (!Number.isFinite(count) || count < 1) count = 50;
  if (!Number.isFinite(perOpTimeoutMs) || perOpTimeoutMs < 5000) perOpTimeoutMs = 60_000;
  return { count, perOpTimeoutMs };
}

// Same prompt rotation — small, varied enough that a cached/dedup'd
// response wouldn't hide a failure. All cheap (single-token replies).
const PROMPTS: readonly string[] = [
  "Reply with exactly: ok.",
  "Reply with exactly: yes.",
  "Reply with exactly: done.",
  "Reply with exactly: 1.",
  "Reply with exactly: hi.",
];

async function buildInteractiveOp(idx: number): Promise<Op> {
  const task = PROMPTS[idx % PROMPTS.length];
  const opType = "freeform";
  const lane = "interactive" as const;
  const contextPack = await buildContextPack({
    description: task,
    successCriteria: [],
    constraints: [],
    notWhatToRedo: [],
    referencedFilePaths: [],
    lane,
    budget: { maxIterations: 5, maxWallTimeMs: 60_000 },
  });
  return {
    id: newOpId(`op_${opType}_soak`),
    type: opType,
    task,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "canonical-loop-soak",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}

async function awaitTerminal(opId: string, timeoutMs: number): Promise<"succeeded" | "failed" | "cancelled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = readOp(opId)?.canonical?.state;
    if (s === "succeeded" || s === "failed" || s === "cancelled") return s;
    await sleep(100);
  }
  return "timeout";
}

interface OpResult {
  opId: string;
  finalState: string;
  durationMs: number;
  invariants: { name: string; pass: boolean }[];
  failedInvariants: string[];
  hasAdapterError: boolean;
  hasSeqGap: boolean;
  hasDuplicateTerminal: boolean;
  providerStateOk: boolean;
  opTurnsCount: number;
}

function checkOp(opId: string, finalState: string, durationMs: number): OpResult {
  const op = readOp(opId);
  const events = readCanonicalEvents(opId);
  const latestTurn = readLatestOpTurn(opId);

  const adapterErrors = events.filter(e => e.type === "error" && (e.body as { code?: string })?.code === "adapter_error");
  const allErrors = events.filter(e => e.type === "error");
  const stateChanges = events.filter(e => e.type === "state_changed");
  const terminalChanges = stateChanges.filter(e => {
    const to = (e.body as { to?: string })?.to;
    return to === "succeeded" || to === "failed" || to === "cancelled";
  });

  // Seq monotonic 0..N
  const seqGaps: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i].seq !== i) seqGaps.push(i);

  // Provider state present + within cap (only meaningful if a turn committed).
  let providerStateOk = true;
  let opTurnsCount = 0;
  if (latestTurn) {
    opTurnsCount = latestTurn.turnIdx + 1;
    const psSize = Buffer.byteLength(JSON.stringify(latestTurn.providerState), "utf8");
    const adapterMatches = latestTurn.providerState?.adapterName === ANTHROPIC_ADAPTER_NAME;
    if (psSize > PROVIDER_STATE_MAX_BYTES_DEFAULT) providerStateOk = false;
    if (!adapterMatches) providerStateOk = false;
  } else if (finalState === "succeeded") {
    // Succeeded with zero op_turns is wrong.
    providerStateOk = false;
  }

  const leaseCleared = (op?.canonical?.leaseOwner ?? null) === null
    && (op?.canonical?.leaseExpiresAt ?? null) === null;

  const invariants: { name: string; pass: boolean }[] = [
    { name: "final state === succeeded", pass: finalState === "succeeded" },
    { name: "exactly one terminal state_changed", pass: terminalChanges.length === 1 },
    { name: "no adapter_error events", pass: adapterErrors.length === 0 },
    { name: "no error events at all", pass: allErrors.length === 0 },
    { name: "per-op seq monotonic 0..N (no gaps)", pass: seqGaps.length === 0 },
    { name: "op_turns count >= 1", pass: opTurnsCount >= 1 },
    { name: "provider_state OK (present + within cap + adapter matches)", pass: providerStateOk },
    { name: "leaseOwner / leaseExpiresAt cleared at terminal", pass: leaseCleared },
    { name: "op.canonical.flagValue === true (proves canonical served it)", pass: op?.canonical?.flagValue === true },
  ];

  const failed = invariants.filter(i => !i.pass).map(i => i.name);

  return {
    opId,
    finalState,
    durationMs,
    invariants,
    failedInvariants: failed,
    hasAdapterError: adapterErrors.length > 0,
    hasSeqGap: seqGaps.length > 0,
    hasDuplicateTerminal: terminalChanges.length > 1,
    providerStateOk,
    opTurnsCount,
  };
}

async function main(): Promise<void> {
  const cfg = parseConfig();

  if (process.env.LAX_CANONICAL_LOOP_INTERACTIVE !== "1"
      && process.env.LAX_CANONICAL_LOOP_ALL !== "1") {
    console.error("FATAL: LAX_CANONICAL_LOOP_INTERACTIVE=1 (or LAX_CANONICAL_LOOP_ALL=1) is required.");
    console.error("Soak is meaningful only when the production flag routes interactive ops to canonical.");
    process.exit(2);
  }

  // Production startup wiring.
  bootstrapCanonicalLoop();

  // Sanity: bootstrap actually registered an Anthropic factory for interactive.
  const probe = await buildInteractiveOp(0);
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

  console.log(`canonical-loop interactive-lane soak`);
  console.log(`count=${cfg.count}, per-op timeout=${cfg.perOpTimeoutMs}ms`);
  console.log(`adapter: ${adapterProbe.name} v${adapterProbe.version}`);
  console.log("─".repeat(72));

  const results: OpResult[] = [];
  const wallStart = Date.now();

  for (let i = 0; i < cfg.count; i++) {
    const op = await buildInteractiveOp(i);
    const routing = decideSubmitRouting(op);
    if (routing.route !== "canonical") {
      console.error(`[${i + 1}/${cfg.count}] FATAL: op ${op.id} routed to "${routing.route}" — flag misconfigured?`);
      process.exit(2);
    }
    const startMs = Date.now();
    canonicalLoopEntry(op);
    const finalState = await awaitTerminal(op.id, cfg.perOpTimeoutMs);
    const durationMs = Date.now() - startMs;
    const result = checkOp(op.id, finalState, durationMs);
    results.push(result);

    const tag = result.failedInvariants.length === 0 ? "PASS" : "FAIL";
    console.log(
      `[${String(i + 1).padStart(3, " ")}/${cfg.count}] ${tag}  ${op.id}  state=${finalState.padEnd(10)}  ${durationMs}ms  turns=${result.opTurnsCount}` +
      (result.failedInvariants.length > 0 ? `  ← ${result.failedInvariants.join("; ")}` : ""),
    );
  }

  await awaitIdle(5_000).catch(() => undefined);
  const wallMs = Date.now() - wallStart;

  // ── Summary ────────────────────────────────────────────────────────────
  const total = results.length;
  const succeeded = results.filter(r => r.finalState === "succeeded").length;
  const failed = results.filter(r => r.finalState === "failed").length;
  const cancelled = results.filter(r => r.finalState === "cancelled").length;
  const timedOut = results.filter(r => r.finalState === "timeout").length;
  const adapterErrors = results.filter(r => r.hasAdapterError).length;
  const seqGaps = results.filter(r => r.hasSeqGap).length;
  const dupTerminals = results.filter(r => r.hasDuplicateTerminal).length;
  const providerStateBad = results.filter(r => !r.providerStateOk).length;
  const stuckRunning = results.filter(r => r.finalState !== "succeeded" && r.finalState !== "failed" && r.finalState !== "cancelled").length;
  const failedOps = results.filter(r => r.failedInvariants.length > 0);

  const allPass = failedOps.length === 0;
  const successDurations = results.filter(r => r.finalState === "succeeded").map(r => r.durationMs).sort((a, b) => a - b);
  const median = successDurations.length > 0 ? successDurations[Math.floor(successDurations.length / 2)] : null;
  const p95 = successDurations.length > 0 ? successDurations[Math.min(successDurations.length - 1, Math.floor(successDurations.length * 0.95))] : null;

  console.log("─".repeat(72));
  console.log(`=== summary (wall ${(wallMs / 1000).toFixed(1)}s) ===`);
  console.log(`total                        ${total}`);
  console.log(`succeeded                    ${succeeded}`);
  console.log(`failed                       ${failed}`);
  console.log(`cancelled                    ${cancelled}`);
  console.log(`timed out                    ${timedOut}`);
  console.log(`stuck running                ${stuckRunning}`);
  console.log(`adapter_error count          ${adapterErrors}`);
  console.log(`duplicate terminal count     ${dupTerminals}`);
  console.log(`seq gap count                ${seqGaps}`);
  console.log(`provider_state failures      ${providerStateBad}`);
  if (median !== null) {
    console.log(`median latency (succeeded)   ${median}ms`);
    console.log(`p95 latency (succeeded)      ${p95}ms`);
  }
  if (failedOps.length > 0) {
    console.log(`\n=== failure detail ===`);
    for (const r of failedOps) {
      console.log(`  ${r.opId}  state=${r.finalState}  failures: ${r.failedInvariants.join("; ")}`);
    }
  }

  console.log(allPass ? "\nSOAK PASSED" : "\nSOAK FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error("soak crashed:", e);
  process.exit(2);
});

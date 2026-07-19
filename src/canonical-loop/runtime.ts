/**
 * Canonical-loop runtime registry (Issue 03).
 *
 * Singleton state for:
 *   - adapter factories keyed by op_id (test-fixture style) or by lane
 *     (production default — Issue 09 wires Anthropic for `interactive`)
 *   - the active tool dispatcher
 *
 * No business logic lives here — it's the dependency-injection seat the
 * scheduler/worker pull from when driving an op. Test cleanup calls
 * resetCanonicalRuntime() to drop registrations between tests.
 */
import type { ExactDelegatedRuntimeDescriptor, Op } from "../ops/types.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { opDir } from "../ops/event-log.js";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync } from "../server-utils.js";
import type { Adapter, AdapterReport, ToolDescriptor, TurnInput, TurnResult } from "./adapter-contract.js";
import { NotConfiguredToolDispatcher, type ToolDispatcher } from "./tool-dispatch.js";
import type { CanonicalLane } from "./types.js";
import { assertExactDelegatedRuntime } from "./provider-adapter-factory.js";
import { createRecoveredAdapterFactory, markRuntimeReconstructionTerminal } from "./runtime-reconstruction.js";
import { readLatestOpTurn } from "./store.js";
import { verifyDelegatedRuntimeIntegrity } from "./runtime-integrity.js";
import { ANTHROPIC_ADAPTER_NAME, ANTHROPIC_ADAPTER_VERSION } from "./adapters/anthropic/types.js";
import { CODEX_ADAPTER_NAME, CODEX_ADAPTER_VERSION } from "./adapters/codex.js";
import { GEMINI_NATIVE_ADAPTER_NAME, GEMINI_NATIVE_ADAPTER_VERSION } from "./adapters/gemini-native.js";
import { OPENAI_COMPAT_ADAPTER_NAME, OPENAI_COMPAT_ADAPTER_VERSION } from "./adapters/openai-compat/types.js";

export type AdapterFactory = () => Adapter | Promise<Adapter>;

const opAdapters = new Map<string, AdapterFactory>();
const laneAdapters = new Map<CanonicalLane, AdapterFactory>();
const opDispatchers = new Map<string, ToolDispatcher>();
const opTools = new Map<string, ToolDescriptor[]>();
const opRuntimeCleanups = new Map<string, () => void>();
const opBaselineTokens = new Map<string, number>();
const learnedProtocolEnvelopes = new Map<string, LearnedProtocolEnvelope>();
let toolDispatcher: ToolDispatcher = new NotConfiguredToolDispatcher();

export interface LearnedProtocolEnvelope {
  slug: string;
  versionId: string;
  candidateId: string;
  allowedTools: readonly string[];
}

const LEARNED_ENVELOPE_FILE = "learned-protocol-envelope.json";

function learnedEnvelopePath(opId: string, createDir = false): string {
  if (createDir) return join(opDir(opId), LEARNED_ENVELOPE_FILE);
  const base = resolve(getLaxDir(), "operations");
  const candidate = resolve(base, opId, LEARNED_ENVELOPE_FILE);
  if (!candidate.startsWith(base + sep)) throw new Error("Invalid canonical operation id");
  return candidate;
}

function parseLearnedEnvelope(raw: string): LearnedProtocolEnvelope {
  const value = JSON.parse(raw) as Partial<LearnedProtocolEnvelope>;
  if (
    typeof value.slug !== "string" || typeof value.versionId !== "string"
    || typeof value.candidateId !== "string" || !Array.isArray(value.allowedTools)
    || value.allowedTools.some((tool) => typeof tool !== "string")
  ) throw new Error("Invalid persisted learned protocol envelope");
  return { slug: value.slug, versionId: value.versionId, candidateId: value.candidateId, allowedTools: value.allowedTools };
}

/** Register a factory that produces the adapter for a specific op_id. */
export function registerAdapterForOp(opId: string, factory: AdapterFactory): void {
  opAdapters.set(opId, factory);
}

/** Remove a per-op adapter factory when its owning runner reaches terminal. */
export function unregisterAdapterForOp(opId: string): void {
  opAdapters.delete(opId);
}

/** Register the default factory used for any op in a given lane that has no per-op override. */
export function setDefaultAdapterForLane(lane: CanonicalLane, factory: AdapterFactory): void {
  laneAdapters.set(lane, factory);
}

/**
 * Register a per-op tool dispatcher. Per-op dispatchers take precedence over
 * the global one — needed for chat ops where each session has its own tool
 * registry, security context, and event-emit callback.
 *
 * Lifetime: caller is responsible for removing the entry when the op
 * terminates (call `unregisterToolDispatcherForOp(opId)`). The runtime
 * doesn't auto-clean because it has no terminal-state hook today.
 */
export function registerToolDispatcherForOp(opId: string, d: ToolDispatcher): void {
  opDispatchers.set(opId, d);
}

export function unregisterToolDispatcherForOp(opId: string): void {
  releaseRuntimeSurfaceForRetry(opId);
  clearLearnedProtocolEnvelopeForOp(opId);
}

/** Release only process-local reconstructed state before a retry. Durable
 * learned-protocol authority and checkpoints remain byte-identical. */
export function releaseRuntimeSurfaceForRetry(opId: string): void {
  opDispatchers.delete(opId);
  opTools.delete(opId);
  const cleanup = opRuntimeCleanups.get(opId);
  opRuntimeCleanups.delete(opId);
  cleanup?.();
}

export function registerRuntimeCleanupForOp(opId: string, cleanup: () => void): void {
  opRuntimeCleanups.get(opId)?.();
  opRuntimeCleanups.set(opId, cleanup);
}

export function registerLearnedProtocolEnvelopeForOp(
  opId: string,
  envelope: LearnedProtocolEnvelope,
): void {
  // Include the durable sidecar in the conflict check: after a process
  // restart, selecting a different protocol must not overwrite/expand the
  // envelope that already governs the resumed operation.
  const existing = getLearnedProtocolEnvelopeForOp(opId);
  if (existing) {
    if (
      existing.slug === envelope.slug
      && existing.versionId === envelope.versionId
      && existing.candidateId === envelope.candidateId
      && JSON.stringify(existing.allowedTools) === JSON.stringify(envelope.allowedTools)
    ) return;
    throw new Error(`A learned protocol is already selected for operation ${opId}`);
  }
  const persisted = {
    ...envelope,
    allowedTools: Object.freeze([...envelope.allowedTools]),
  };
  atomicWriteFileSync(learnedEnvelopePath(opId, true), JSON.stringify(envelope), { mode: 0o600 });
  learnedProtocolEnvelopes.set(opId, persisted);
}

export function getLearnedProtocolEnvelopeForOp(opId: string): LearnedProtocolEnvelope | null {
  let envelope = learnedProtocolEnvelopes.get(opId);
  if (!envelope) {
    const path = learnedEnvelopePath(opId);
    if (!existsSync(path)) return null;
    envelope = parseLearnedEnvelope(readFileSync(path, "utf8"));
    learnedProtocolEnvelopes.set(opId, { ...envelope, allowedTools: Object.freeze([...envelope.allowedTools]) });
  }
  return envelope ? { ...envelope, allowedTools: [...envelope.allowedTools] } : null;
}

export function clearLearnedProtocolEnvelopeForOp(opId: string): void {
  learnedProtocolEnvelopes.delete(opId);
  rmSync(learnedEnvelopePath(opId), { force: true });
}

/**
 * Register the tool list for an op. The canonical loop's `turn-loop` reads
 * this on every turn to populate `TurnInput.tools` for the adapter — that's
 * how the model is told which tools are available. Without this, ops get
 * `tools: []` and the model has no tool surface (the user sees "refused"
 * or "in planning mode" responses for tool-needing requests).
 *
 * Lifetime: caller is responsible for `unregisterToolsForOp(opId)` on
 * terminal — same pattern as the per-op dispatcher.
 */
export function registerToolsForOp(opId: string, tools: ToolDescriptor[]): void {
  opTools.set(opId, tools);
}

export function unregisterToolsForOp(opId: string): void {
  opTools.delete(opId);
}

/** Resolve tools for an op. Returns [] when nothing is registered. */
export function getToolsForOp(opId: string): ToolDescriptor[] {
  return opTools.get(opId) ?? [];
}

/**
 * Register the op's BASELINE token cost — the system prompt + tool-schema
 * manifest (+ injected memory, which lives inside the system prompt). This is
 * sent as separate request params by the adapter, so it is INVISIBLE to the
 * conversation-estimate sizing in compact-history / getContextStatus. Recording
 * it once at submit (both inputs are static for the op's life) lets the
 * compaction gate add it as a floor when there is no real-usage anchor to size
 * against — the anchor already includes the baseline, the pure estimate does
 * not. Without this, sizing undercounts the real request by ~147k on the chat
 * path and thresholds fire far too late. Lifetime mirrors the tool registry.
 */
export function registerOpBaselineTokens(opId: string, tokens: number): void {
  opBaselineTokens.set(opId, tokens);
}

export function unregisterOpBaselineTokens(opId: string): void {
  opBaselineTokens.delete(opId);
}

/** Resolve the op's baseline token cost. Returns 0 when nothing is registered
 * (agent/background ops don't register one → sizing unchanged for them). */
export function getOpBaselineTokens(opId: string): number {
  return opBaselineTokens.get(opId) ?? 0;
}

/** Restore the runtime registration that a delegated op persisted at submit.
 *  Checkpoint messages/provider state stay in the canonical store; this only
 *  rebuilds the process-local adapter factory that cannot survive a restart.
 *  Unsupported persisted shapes get an explicit fail-closed factory. */
export function rehydrateRecoveredRuntime(op: Op): boolean {
  if (opAdapters.has(op.id)) return true;
  let descriptor: ExactDelegatedRuntimeDescriptor;
  try {
    verifyDelegatedRuntimeIntegrity(op);
    descriptor = op.runtimeDescriptor;
    assertExactDelegatedRuntime(descriptor);
    if (op.model !== descriptor.model) throw new Error("operation model does not match persisted runtime identity");
    if (!descriptor.sessionId || op.canonical?.sessionId !== descriptor.sessionId) throw new Error("operation session does not match persisted runtime identity");
    const prior = readLatestOpTurn(op.id);
    const adapterIdentity = adapterIdentityForRuntime(descriptor.runtime);
    if (prior && (prior.providerState.adapterName !== adapterIdentity.name
      || prior.providerState.adapterVersion !== adapterIdentity.version)) {
      throw new Error("checkpoint provider state does not match persisted runtime identity");
    }
  } catch {
    markRuntimeReconstructionTerminal(op, "identity_mismatch");
    registerAdapterForOp(op.id, lostRegistrationAdapterFactory);
    return false;
  }
  registerAdapterForOp(op.id, createRecoveredAdapterFactory(
    op,
    descriptor,
    () => releaseRuntimeSurfaceForRetry(op.id),
  ));
  return true;
}

function hasExactDelegatedRuntime(op: Op): boolean {
  try {
    verifyDelegatedRuntimeIntegrity(op);
    assertExactDelegatedRuntime(op.runtimeDescriptor);
    return op.model === op.runtimeDescriptor.model
      && !!op.runtimeDescriptor.sessionId
      && op.canonical?.sessionId === op.runtimeDescriptor.sessionId;
  } catch {
    return false;
  }
}

function adapterIdentityForRuntime(runtime: ExactDelegatedRuntimeDescriptor["runtime"]): { name: string; version: string } {
  if (runtime === "anthropic") return { name: ANTHROPIC_ADAPTER_NAME, version: ANTHROPIC_ADAPTER_VERSION };
  if (runtime === "codex") return { name: CODEX_ADAPTER_NAME, version: CODEX_ADAPTER_VERSION };
  if (runtime === "gemini-native") return { name: GEMINI_NATIVE_ADAPTER_NAME, version: GEMINI_NATIVE_ADAPTER_VERSION };
  return { name: OPENAI_COMPAT_ADAPTER_NAME, version: OPENAI_COMPAT_ADAPTER_VERSION };
}

/** Inject the global tool dispatcher used when no per-op dispatcher is registered. */
export function setToolDispatcher(d: ToolDispatcher): void {
  toolDispatcher = d;
}

/**
 * Resolve the dispatcher for an op. Per-op override wins; falls back to the
 * global dispatcher (default `NotConfiguredToolDispatcher`).
 *
 * The legacy zero-arg signature stays valid for callers that don't have an
 * opId in scope — they get the global dispatcher.
 */
export function getToolDispatcher(opId?: string): ToolDispatcher {
  if (opId) {
    const d = opDispatchers.get(opId);
    if (d) return d;
  }
  return toolDispatcher;
}

// ── Lost-registration fail-closed adapter (OP-4) ──────────────────────────

/** Error code emitted by the lost-registration adapter (OP-4). */
export const LOST_REGISTRATION_ERROR_CODE = "adapter_registration_lost";

/** Human-facing reason finalized onto an op whose adapter registration was
 *  lost across a process restart. Carries the "resubmit me" instruction. */
export const LOST_REGISTRATION_REASON =
  "adapter registration was lost across a process restart — resubmit this op to rebuild its adapter and tools";

/**
 * Fail-closed adapter for a genuinely restart-recovered op whose in-memory
 * per-op adapter registration died with the old process and was never
 * re-created (OP-4). The alternative — silently falling back to the lane
 * default — hands the op the WRONG adapter and, worse, ZERO tools
 * (getToolsForOp === [], since the per-op tool registration is gone too), so
 * the model drops into tool-less "planning mode" and the op looks alive while
 * doing nothing. Instead this adapter reports one non-retryable error and
 * returns terminalReason:"error", which commitTurn maps to running -> failed
 * (checkpoint.ts). The op finalizes with the resubmit reason so its submitter
 * re-creates it (and its registration) from scratch.
 */
function createLostRegistrationAdapter(): Adapter {
  return {
    name: "lost-registration",
    version: "1",
    async runTurn(_input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
      report({
        kind: "error",
        code: LOST_REGISTRATION_ERROR_CODE,
        message: LOST_REGISTRATION_REASON,
        retryable: false,
      });
      return {
        providerState: {
          adapterName: "lost-registration",
          adapterVersion: "1",
          providerPayload: null,
        },
        terminalReason: "error",
      };
    },
    async abort(): Promise<void> {
      /* nothing is in flight — no provider call was ever made */
    },
  };
}

/**
 * The canonical fail-closed factory (OP-4). Exported so bootstrap can wire it
 * as the `agent` lane default — an agent-spawn op always registers its own
 * per-op adapter, so the lane default is only ever reached for an agent op
 * whose registration was lost (a queued-at-crash op recovered after a restart,
 * whose attemptCount is still 0 because the OP-6 requeue path consumes no
 * recovery attempt). Without a lane factory that op would queue forever; with
 * this one it finalizes running -> failed instead of hanging.
 */
export function lostRegistrationAdapterFactory(): Adapter {
  return createLostRegistrationAdapter();
}

/** Resolve the adapter factory for `op` (per-op override wins over lane default). */
export function resolveAdapterFactory(op: Op): AdapterFactory | null {
  const f = opAdapters.get(op.id);
  if (f) return f;
  // No per-op registration. Two very different situations produce that shape:
  //
  //   (a) an op that LEGITIMATELY rides the lane default — a fresh submission,
  //       or an in-process pause->resume (opResume stays in the SAME process,
  //       so the lane + per-op registry is fully intact). Serve the lane
  //       default: it's the right adapter for these ops.
  //
  //   (b) a genuine restart-recovery relaunch — the process died and every
  //       per-op registration was lost with it, and nothing re-created this
  //       op's. Falling back to the lane default here drives the op on the
  //       wrong adapter with ZERO tools (OP-4 "planning mode"). Fail closed.
  //
  // attemptCount identifies restart recovery. A validated delegated-op
  // descriptor whose model matches the op proves the original runtime is
  // reconstructible; without one,
  // attemptCount > 0 remains the lost-registration fail-closed signal. An
  // in-process opResume never increments the count and keeps using its live
  // registration, even when the op already has committed turns on disk.
  if ((op.attemptCount ?? 0) > 0 && !hasExactDelegatedRuntime(op)) {
    return lostRegistrationAdapterFactory;
  }
  const lane = op.lane as CanonicalLane;
  return laneAdapters.get(lane) ?? null;
}

/** Drop adapter registrations and restore the no-op tool dispatcher. */
export function resetCanonicalRuntime(): void {
  opAdapters.clear();
  laneAdapters.clear();
  opDispatchers.clear();
  opTools.clear();
  for (const cleanup of opRuntimeCleanups.values()) cleanup();
  opRuntimeCleanups.clear();
  opBaselineTokens.clear();
  learnedProtocolEnvelopes.clear();
  toolDispatcher = new NotConfiguredToolDispatcher();
}

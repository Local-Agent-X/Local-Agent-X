/**
 * The turn's model call: one `adapter.runTurn`, with the idle watchdog armed
 * around it, its report stream folded into a `ModelCall`, and the two ways a
 * call can end the turn on the spot (a thrown error, a reported error the
 * recovery turns into a retry).
 *
 * Owns: forwarding stream / reasoning / redact chunks to the ephemeral bus,
 * collecting finalized messages, requested tool calls and out-of-band observed
 * tools, the `error` event for a reported adapter error, the stall abort, the
 * model-time measurement, and what the call tells decideTurnOutcome
 * (`modelCallSignals`).
 *
 * Does not own: the recovery policies themselves (adapter-throw-recovery.ts,
 * reported-adapter-recovery.ts), the watchdog timer (idle-watchdog.ts), turn
 * input assembly (build-input.ts), or anything after the call returns —
 * middleware phases, tool dispatch and commit stay with the conductor
 * (../turn-loop.ts). The adapter never writes; it only reports.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ToolCall } from "../contract-types.js";
import type { Op } from "../../ops/types.js";
import type { DecideOutcomeInput } from "./decide-outcome.js";
import type { ResolvedTurnLoopDeps } from "./turn-deps.js";
import type { DriveTurnResult } from "./types.js";
import { recoverAdapterThrow, clearAdapterThrowStreak } from "./adapter-throw-recovery.js";
import { recoverReportedAdapterError } from "./reported-adapter-recovery.js";
import { elapsedMs, monotonicNow } from "../elapsed.js";

export interface AdapterError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Everything one returned model call produced, as the rest of the turn reads it. */
export interface ModelCall {
  result: TurnResult;
  finalized: CanonicalMessage[];
  /** The LIVE array the afterModelCall middlewares may push onto and tool
   *  dispatch reads — one reference for the whole turn. */
  toolCalls: ToolCall[];
  observedTools: string[];
  /** Reasoning streamed this turn (`heartbeat` = reasoning model streaming
   *  chain-of-thought, adapter-contract.ts). Bus-only, so nothing else records it. */
  sawReasoning: boolean;
  /** A reported (or watchdog-synthesized `stalled`) error; null on a clean call. */
  adapterError: AdapterError | null;
  /** The assistant's text across this call's finalized messages. */
  assistantText: string;
  modelMs: number;
}

export type ModelCallOutcome =
  | { kind: "returned"; call: ModelCall }
  /** The call ended the turn: a thrown error, or a reported one turned into a retry. */
  | { kind: "ended"; turnResult: DriveTurnResult };

type ModelCallDeps = Pick<ResolvedTurnLoopDeps,
  "emit" | "publishStreamChunk" | "createIdleWatchdog" | "readIdleTimeoutMs" | "extractText">;

export async function runModelCall(
  op: Op,
  adapter: Adapter,
  input: TurnInput,
  turnIdx: number,
  deps: ModelCallDeps,
): Promise<ModelCallOutcome> {
  const { emit, publishStreamChunk, createIdleWatchdog, readIdleTimeoutMs, extractText } = deps;
  const finalized: CanonicalMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const observedTools: string[] = [];
  let sawReasoning = false;
  let sawStreamContent = false;
  let adapterError: AdapterError | null = null;

  // Idle-event detection — provider-agnostic. Watches the report stream
  // for ANY activity (stream chunks, tool calls, finalized messages,
  // errors). If nothing arrives for idleMs the adapter is assumed stuck
  // and we abort with reason "idle-stalled" so transports that recognize
  // it (warm-pool's reason matcher) can hard-kill the underlying CLI/HTTP
  // connection. Lives behind a shared watchdog so any future adapter
  // (xai, gemini, local) inherits it. The stall surfaces as adapterError.
  const idleMs = readIdleTimeoutMs();
  const watchdog = createIdleWatchdog({
    idleMs,
    onTimeout: () => {
      adapterError = { code: "stalled", message: `no adapter reports for ${idleMs}ms — model presumed stuck`, retryable: false };
      // Fire-and-forget — don't await; runTurn may still need a beat to
      // unwind. The reason propagates through the abort signal so
      // transports that watch reason (warm-pool kill on /idle|stalled|stop/)
      // do the right thing.
      void adapter.abort(new Error("idle-stalled"));
    },
  });

  // Time-component split for soak: how much of the turn was spent inside
  // the adapter's model call vs dispatching tools. Together with
  // commitMs (small, not separately tracked) and any caller-side prep,
  // they reconstruct where the turn's wall-clock went.
  const modelStart = monotonicNow();
  let result: TurnResult;
  try {
    result = await adapter.runTurn(input, (r: AdapterReport) => {
      watchdog.noteActivity();
      if (r.kind === "heartbeat") { sawReasoning = true; return; }
      if (r.kind === "reasoning_chunk") {
        // Live chain-of-thought. Rides the same ephemeral stream bus as text
        // (bus-only, never persisted) with a `reasoning` marker so the pump
        // maps it to a `reasoning` ServerEvent instead of answer text.
        sawReasoning = true;
        sawStreamContent = true;
        publishStreamChunk(op.id, { reasoning: true, delta: r.delta });
        return;
      }
      if (r.kind === "stream_chunk") {
        sawStreamContent = true;
        publishStreamChunk(op.id, r.body);
        return;
      }
      if (r.kind === "stream_redact") {
        // The adapter post-processed its already-streamed text (e.g.
        // tool-call extraction) and wants the UI to retract part of it.
        // Re-uses the stream-chunk publish path with a `replace: true`
        // marker so the client can swap the bubble's text rather than
        // append.
        publishStreamChunk(op.id, { replace: true, text: r.replacementText });
        return;
      }
      if (r.kind === "message_finalized") {
        finalized.push(r.message);
        return;
      }
      if (r.kind === "tool_call_requested") {
        toolCalls.push(r.call);
        return;
      }
      if (r.kind === "tool_observed") {
        observedTools.push(r.tool);
        return;
      }
      if (r.kind === "error") {
        adapterError = { code: r.code, message: r.message, retryable: r.retryable };
        emit(op.id, "error", { code: r.code, message: r.message, retryable: r.retryable });
      }
    });
  } catch (e) {
    // Thrown (unreported) adapter error — see adapter-throw-recovery.ts.
    watchdog.disarm();
    return { kind: "ended", turnResult: recoverAdapterThrow(op, e, turnIdx) };
  }
  watchdog.disarm();
  // A model call that actually returned (success, or a reported kind:"error")
  // breaks the THROWN-error streak — the provider is responding again.
  clearAdapterThrowStreak(op.id);
  // A REPORTED over-window error (adapter converted the provider's
  // context_overflow/413 into kind:"error" instead of throwing) gets the same
  // forced-compact-and-retry as the thrown path — without this it would ride
  // adapterError straight to terminal "error" and kill the op. Bounded by the
  // recovery's own attempt cap; success clears the counter.
  // (read via a typed local: adapterError is assigned inside the stream
  // callback, which TS's narrowing can't see — it types the direct read `never`)
  const reportedError = adapterError as AdapterError | null;
  const recoveredReport = recoverReportedAdapterError(op, reportedError, turnIdx, {
    streamed: sawStreamContent, finalized: finalized.length,
    toolCalls: toolCalls.length, observedTools: observedTools.length,
  });
  if (recoveredReport) return { kind: "ended", turnResult: recoveredReport };
  const modelMs = elapsedMs(modelStart);
  const assistantText = finalized
    .filter(m => m.role === "assistant")
    .map(m => extractText(m.content))
    .join("");
  return {
    kind: "returned",
    call: { result, finalized, toolCalls, observedTools, sawReasoning, adapterError: reportedError, assistantText, modelMs },
  };
}

/** The part of decideTurnOutcome's input that comes from the model call. */
export function modelCallSignals(call: ModelCall): Pick<DecideOutcomeInput,
  "finalized" | "toolCalls" | "observedTools" | "assistantText" | "adapterTerminalReason"
  | "modelSignaledDone" | "modelWantsToContinue" | "hasReasoning" | "adapterError" | "providerStop"> {
  const { result } = call;
  const payloadStop = (result.providerState?.providerPayload as Record<string, unknown> | undefined)?.stopReason;
  return {
    finalized: call.finalized,
    toolCalls: call.toolCalls,
    observedTools: call.observedTools,
    assistantText: call.assistantText,
    adapterTerminalReason: result.terminalReason ?? null,
    // The model's REAL stop signal (end_turn / stop), when the provider
    // carried it. decide-outcome trusts this to terminate even a non-silent
    // tool turn in one pass; absence → it falls back to shape inference.
    modelSignaledDone: result.modelStop === "ended",
    modelWantsToContinue: result.modelStop === "continue",
    // Reasoning is bus-only (never persisted into finalized), so decide-outcome
    // can't infer it from assistantText/finalized — thread the turn's real
    // signal so its interactive empty-turn terminator never truncates a
    // reasoning-only turn (HE-5).
    hasReasoning: call.sawReasoning,
    adapterError: call.adapterError,
    providerStop: typeof payloadStop === "string" ? payloadStop : undefined,
  };
}

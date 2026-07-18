/**
 * Injectable collaborator seams for the turn conductor (../turn-loop.ts).
 * Every helper driveTurn calls directly is declared here as an optional
 * override on its trailing deps parameter, so the conductor's control flow
 * (cancel ordering, middleware phase short-circuits, commit gating) is
 * testable through one interface without vi.mock.
 *
 * Behavior contract: each default is EXACTLY the concrete import turn-loop
 * called before this file existed, resolved at the same TIME (once per
 * driveTurn call, never hoisted to module scope) — the middleware stack,
 * idle-timeout config, and per-op tool registry are runtime-mutable, so
 * each turn must still read them at the moment it runs.
 */
import { emit, emitErrorOnce, publishStreamChunk } from "../event-emitter.js";
import { commitTurn } from "../checkpoint.js";
import { runMiddlewarePhase } from "../middlewares/host.js";
import { buildToolResultsView, extractText, extractToolResultText } from "./content-extract.js";
import { appendNudgeAsUserMessage, middlewareAbortResult } from "./nudges.js";
import { buildTurnInput, readPendingRedirect } from "./build-input.js";
import { drainInjectsIntoTurn } from "./inject-drain.js";
import { opConsumesInjects } from "../../agent-loop/inject-queue.js";
import { dispatchTools } from "./dispatch-tools.js";
import { createIdleWatchdog, readIdleTimeoutMs } from "./idle-watchdog.js";
import { snapshotTouchedApps } from "./snapshot-apps.js";
import { decideTurnOutcome } from "./decide-outcome.js";
import { createTurnContextComposer } from "./context-composition.js";
import { recordCommittedLearningOutcome, resolveLearningSessionId } from "./record-outcome.js";

/** Overrides for the collaborators the conductor drives. Every field is
 *  optional; an absent field means "the real module function, resolved at
 *  driveTurn time". NOT on this surface (deliberately): the adapter-throw /
 *  context-overflow recovery quartet and the error classifier — recovery is
 *  itself under test through driveTurn (its retract-then-nudge behavior is
 *  the CL-8 invariant), and classify is a pure function. */
export interface TurnLoopDeps {
  /** op_events writer + ephemeral stream bus (event-emitter.ts). */
  emit?: typeof emit;
  emitErrorOnce?: typeof emitErrorOnce;
  publishStreamChunk?: typeof publishStreamChunk;
  /** The atomic post-turn write — op_turns row, messages, terminal transition. */
  commitTurn?: typeof commitTurn;
  /** Canonical safety-middleware phase runner (middlewares/host.ts). */
  runMiddlewarePhase?: typeof runMiddlewarePhase;
  /** Message-content text extraction for middleware context views. */
  extractText?: typeof extractText;
  extractToolResultText?: typeof extractToolResultText;
  buildToolResultsView?: typeof buildToolResultsView;
  /** Middleware nudge/abort write-back into op_messages / op_events. */
  appendNudgeAsUserMessage?: typeof appendNudgeAsUserMessage;
  middlewareAbortResult?: typeof middlewareAbortResult;
  /** Turn input assembly from op_messages + prior providerState. */
  buildTurnInput?: typeof buildTurnInput;
  /** Pre-turn_started snapshot of the redirect column (mid-turn redirects
   *  apply NEXT turn — PRD acceptance #5). */
  readPendingRedirect?: typeof readPendingRedirect;
  /** Mid-turn user injects → op_messages drain (chat_turn/agent_spawn only). */
  drainInjectsIntoTurn?: typeof drainInjectsIntoTurn;
  opConsumesInjects?: typeof opConsumesInjects;
  /** The canonical tool-dispatcher boundary — the loop never executes tools. */
  dispatchTools?: typeof dispatchTools;
  /** Stuck-adapter detection. readIdleTimeoutMs reads hot-reloaded config. */
  createIdleWatchdog?: typeof createIdleWatchdog;
  readIdleTimeoutMs?: typeof readIdleTimeoutMs;
  /** Per-turn app-file snapshot powering the IDE ↺ Revert dropdown. */
  snapshotTouchedApps?: typeof snapshotTouchedApps;
  /** Terminal-reason decision + commit-message assembly (verify gates live here). */
  decideTurnOutcome?: typeof decideTurnOutcome;
  /** Durable self-learning receipt. Called only after commitTurn succeeds. */
  recordCommittedLearningOutcome?: typeof recordCommittedLearningOutcome;
  resolveLearningSessionId?: typeof resolveLearningSessionId;
  /** Per-turn CanonicalLoopContext factory — wraps the middleware stack,
   *  evidence history, and per-op tool registry reads. */
  createTurnContextComposer?: typeof createTurnContextComposer;
}

export type ResolvedTurnLoopDeps = Required<TurnLoopDeps>;

/** Fill every absent override with the concrete module function. Called once
 *  per driveTurn invocation; the defaults are references to the live module
 *  functions, so each turn still reads runtime-mutable state (middleware
 *  stack, idle-timeout config) at the moment it runs. */
export function resolveTurnLoopDeps(deps: TurnLoopDeps = {}): ResolvedTurnLoopDeps {
  return {
    emit: deps.emit ?? emit,
    emitErrorOnce: deps.emitErrorOnce ?? emitErrorOnce,
    publishStreamChunk: deps.publishStreamChunk ?? publishStreamChunk,
    commitTurn: deps.commitTurn ?? commitTurn,
    runMiddlewarePhase: deps.runMiddlewarePhase ?? runMiddlewarePhase,
    extractText: deps.extractText ?? extractText,
    extractToolResultText: deps.extractToolResultText ?? extractToolResultText,
    buildToolResultsView: deps.buildToolResultsView ?? buildToolResultsView,
    appendNudgeAsUserMessage: deps.appendNudgeAsUserMessage ?? appendNudgeAsUserMessage,
    middlewareAbortResult: deps.middlewareAbortResult ?? middlewareAbortResult,
    buildTurnInput: deps.buildTurnInput ?? buildTurnInput,
    readPendingRedirect: deps.readPendingRedirect ?? readPendingRedirect,
    drainInjectsIntoTurn: deps.drainInjectsIntoTurn ?? drainInjectsIntoTurn,
    opConsumesInjects: deps.opConsumesInjects ?? opConsumesInjects,
    dispatchTools: deps.dispatchTools ?? dispatchTools,
    createIdleWatchdog: deps.createIdleWatchdog ?? createIdleWatchdog,
    readIdleTimeoutMs: deps.readIdleTimeoutMs ?? readIdleTimeoutMs,
    snapshotTouchedApps: deps.snapshotTouchedApps ?? snapshotTouchedApps,
    decideTurnOutcome: deps.decideTurnOutcome ?? decideTurnOutcome,
    recordCommittedLearningOutcome: deps.recordCommittedLearningOutcome ?? recordCommittedLearningOutcome,
    resolveLearningSessionId: deps.resolveLearningSessionId ?? resolveLearningSessionId,
    createTurnContextComposer: deps.createTurnContextComposer ?? createTurnContextComposer,
  };
}

/**
 * Canonical-loop middleware contract.
 *
 * Mirrors `src/agent-loop/types.ts:LoopMiddleware` but in canonical terms:
 *
 *   - Legacy "iteration" inside one turn → canonical "turn" inside one op.
 *   - Legacy `toolsCalledThisTurn` (set, across iters) → canonical
 *     `toolsCalledThisOp` (set, across turns).
 *   - Legacy nudge: pushes a user message and short-circuits the iteration
 *     loop. Canonical nudge: appends a user op_message and forces the worker
 *     to drive another turn even when the adapter said `terminalReason=done`.
 *   - Legacy abort: returns a terminal AgentTurn. Canonical abort: marks the
 *     turn-result with a `middlewareAbort` directive so the worker exits the
 *     drive loop and the op transitions to failed.
 *
 * Hook points fire in the same order as agent-loop:
 *
 *   beforeTurn       — top of driveTurn, before adapter.runTurn
 *   afterModelCall   — after adapter.runTurn, before tool dispatch
 *   afterToolExecution — after tool dispatch, before commitTurn
 *
 * Per-op state for middlewares that need to remember things across turns
 * (loop-detection, post-commit, action-claim FIRED flag, etc.) lives in the
 * registry in `state.ts` keyed by opId. Cleared on op-terminal.
 */
import type { Op } from "../../ops/types.js";
import type { ServerEvent } from "../../types.js";
import type { CanonicalMessage, ToolCall, ToolDescriptor } from "../contract-types.js";

/**
 * Lightweight, provider-agnostic representation of one tool result a turn's
 * dispatch produced. Used by afterToolExecution hooks to scan output text
 * (dead-end / post-commit detection).
 */
export interface CanonicalToolResultView {
  toolName: string;
  toolCallId: string;
  /** Best-effort string projection of the tool result for regex inspection. */
  content: string;
}

/**
 * What each middleware sees. Mutable in places where legacy middlewares
 * mutate ctx (toolsCalledThisOp grows as tool calls accrue across phases).
 */
export interface CanonicalLoopContext {
  op: Op;
  turnIdx: number;
  /** The user message that kicked off this op. For chat_turn = first user
   *  op_message; falls back to op.task. */
  userMessage: string;
  /** Provider key — "anthropic" | "codex" | "openai" | "xai" | "gemini" |
   *  "local" | "ollama-cloud" | "custom". Read from
   *  contextPack.preferredProvider with a safe fallback. */
  provider: string;
  /** Model id (used by loop-detection tiering). */
  model: string;

  /** Adapter tools advertised to the model on this turn. */
  tools: ToolDescriptor[];
  /** Set view of tool names — convenience for "is build_app available". */
  toolNames: Set<string>;

  // ── This turn's outputs (populated by turn-loop in phase order) ──
  /** Assistant visible text emitted by the adapter this turn. */
  assistantContent: string;
  /** Tool calls this turn requested. */
  toolCalls: ToolCall[];
  /** Tool results this turn produced (after dispatch). Populated before
   *  afterToolExecution fires. */
  toolResults: CanonicalToolResultView[];

  // ── Cross-turn (op-level) tallies — built by host from op_messages ──
  toolsCalledThisOp: Set<string>;
  committingToolsThisOp: Set<string>;
  /** Per-turn evidence counts, oldest first. Maintained across turns. */
  evidenceHistory: number[];

  /** Forwarder for stream / stopped / etc. events. Lets middlewares put a
   *  visible note in chat when they fire (mirrors agent-loop ctx.req.onEvent
   *  behavior). May be undefined for headless ops (cron, sub-agent). */
  onEvent?: (event: ServerEvent) => void;
}

export type CanonicalMiddlewareResult =
  | { kind: "continue" }
  | { kind: "nudge"; message: string; reason: string }
  | { kind: "abort"; reason: string; message?: string }
  | { kind: "retry-iteration"; reason?: string };

export interface CanonicalMiddleware {
  readonly name: string;
  /** Optional predicate — middleware is skipped when false. */
  when?(ctx: CanonicalLoopContext): boolean;
  beforeTurn?(ctx: CanonicalLoopContext):
    | CanonicalMiddlewareResult
    | Promise<CanonicalMiddlewareResult>;
  afterModelCall?(ctx: CanonicalLoopContext):
    | CanonicalMiddlewareResult
    | Promise<CanonicalMiddlewareResult>;
  afterToolExecution?(ctx: CanonicalLoopContext):
    | CanonicalMiddlewareResult
    | Promise<CanonicalMiddlewareResult>;
}

/** Side-channel for `force-tool-use`. The canonical adapter contract v1 has
 *  no `toolChoice` field on TurnInput, so the middleware writes its intent
 *  to op.canonical.toolChoice and adapters that opt-in read it from there.
 *  Today no adapter reads it — port is parity-by-shim, same as agent-loop's
 *  legacy state of the same middleware (its "forward-compatible shim" note
 *  in src/agent-loop/middlewares/force-tool-use.ts). */
export const TOOL_CHOICE_OP_FIELD = "toolChoice" as const;

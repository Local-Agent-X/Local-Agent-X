/**
 * Unified agent loop — contract types.
 *
 * One loop, N adapters, M composable middlewares. Replaces the three
 * per-provider loops (run-standard, run-anthropic, run-codex/run-http)
 * that each carried their own copy of post-turn detectors, ceiling
 * checks, hallucination guards, etc.
 *
 * Pattern: skinny core loop body + ordered middleware stack with three
 * hook points: beforeIteration / afterModelCall / afterToolExecution.
 * Each middleware is a small file. Order is explicit at registration.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentOptions, ImageAttachment } from "../providers/types.js";
import type { AgentTurn } from "../types.js";
import type { BaseAdapter } from "../providers/adapter/index.js";
import type { PromptLayers } from "../agent-loop-prompt-layers.js";

/**
 * Caller input. Same shape as AgentOptions for now (we already have a
 * stable interface) — re-exported here so callers don't need to know
 * the loop's internals.
 */
export type AgentTurnRequest = AgentOptions & {
  userMessage: string;
  history: ChatCompletionMessageParam[];
  images?: ImageAttachment[];
};

/**
 * Mutable per-turn state. The loop builds this once and threads it
 * through every middleware hook. Middlewares can read AND write —
 * intentional, since most need to push messages, mark tool names,
 * update prompt layers, etc.
 */
export interface LoopContext {
  req: AgentTurnRequest;
  iteration: number;
  messages: ChatCompletionMessageParam[];

  // ── token + time tallies ──
  totalInput: number;
  totalOutput: number;
  turnStartMs: number;

  // ── tool tracking ──
  /** Names of every tool called this turn (across all iterations).
   *  Used by action-claim verification to catch hallucinated claims. */
  toolsCalledThisTurn: Set<string>;
  /** Subset of toolsCalledThisTurn that count as "committing" (write,
   *  bash, send_email, etc.) — used by mid-turn-stale + wall-clock to
   *  avoid aborting a turn that's making real progress. */
  committingToolsThisTurn: Set<string>;
  /** Per-iteration evidence count (for staleness detection). */
  evidenceHistory: number[];

  // ── prompt composition ──
  /** Dynamic layers added/removed by middlewares (ack-fast-path,
   *  website-builder, retry nudge). Recomposed every iteration. */
  promptLayers: PromptLayers;

  // ── adapter handle ──
  /** Resolved at loop entry by provider name. Middlewares can read
   *  adapter.name for provider-conditional behavior; most should NOT. */
  adapter: BaseAdapter;

  // ── per-provider state grab-bag ──
  /** Adapter-owned. Codex stores previousResponseId + turnReasoning
   *  here. The loop never inspects this. */
  providerState: Record<string, unknown>;

  // ── this iteration's model output (set by core after the stream) ──
  assistantContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** Convenience flag — true if any mcp_activity chunks were observed
   *  (Anthropic CLI bridge handled tools internally). */
  sawMcpActivity: boolean;
}

/**
 * What every middleware hook returns. The loop dispatches on `kind`:
 *
 *  - "continue": no-op, proceed to next middleware (or next phase)
 *  - "nudge":    push a user-role message with `message` and continue.
 *                Skips remaining middlewares for THIS hook AND restarts
 *                the iteration (model gets the nudge). Most post-turn
 *                detectors return this.
 *  - "abort":    bail with the supplied AgentTurn. Used by ceiling
 *                checks (token, wall-clock) and final-state detectors.
 *  - "retry-iteration": restart this iteration WITHOUT pushing a
 *                message. Used after context-overflow compaction.
 */
export type MiddlewareResult =
  | { kind: "continue" }
  | { kind: "nudge"; message: string; reason?: string }
  | { kind: "abort"; turn: AgentTurn }
  | { kind: "retry-iteration" };

/**
 * Output of the model call this iteration. Passed to afterModelCall
 * hooks so they can inspect what just happened without re-walking
 * messages.
 */
export interface ModelCallResult {
  assistantContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  sawMcpActivity: boolean;
  finishReason: string;
}

/**
 * Hook contract. All hooks are async + optional — middlewares only
 * implement the phases they care about. The loop walks middlewares in
 * registration order and short-circuits on the first non-"continue"
 * result for each phase.
 */
export interface LoopMiddleware {
  /** Stable identifier for telemetry + debugging. */
  readonly name: string;

  /** Optional: only register this middleware when the predicate passes
   *  (e.g. "only on Anthropic", "only when build_app tool is available").
   *  Defaults to always-on. */
  when?(req: AgentTurnRequest): boolean;

  /** Fires at the top of each iteration, BEFORE the model call.
   *  Use for: ceilings, staleness, subagent drain, prompt-layer setup,
   *  context compaction. */
  beforeIteration?(ctx: LoopContext): Promise<MiddlewareResult> | MiddlewareResult;

  /** Fires after the model stream finishes, BEFORE tool execution.
   *  Use for: post-turn detectors, hallucination checks, action-claim
   *  verification, loop detection, pause-on-auth-needed. */
  afterModelCall?(ctx: LoopContext, result: ModelCallResult): Promise<MiddlewareResult> | MiddlewareResult;

  /** Fires after tools execute and results are pushed into ctx.messages.
   *  Use for: dead-end detection, post-commit nudge. */
  afterToolExecution?(ctx: LoopContext, toolResults: ChatCompletionMessageParam[]): Promise<MiddlewareResult> | MiddlewareResult;
}

/**
 * Re-export for middleware authors who want to push retry-style nudges
 * via prompt layers instead of as user messages.
 */
export type { PromptLayers };

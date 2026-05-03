/**
 * Eval harness — shared types.
 *
 * A "fixture" is a canned conversation: input (user message + tools +
 * system prompt) plus a list of model-response sequences (one per
 * iteration the loop will run) plus expected outcomes. The runner
 * pipes the fixture through both LAX_UNIFIED_LOOP=0 (legacy) and =1
 * (unified) and asserts equivalence — same final messages, same tool
 * calls, same stop reason.
 *
 * Fixtures don't call real models. The replay adapter (registered as
 * `replay-http`) yields pre-canned StreamChunks. That keeps tests
 * fast, free, deterministic, and lets the same fixture pin behavior
 * across providers (the loop's job is provider-agnostic; the adapter
 * is the provider-specific layer).
 */

import type { ToolDefinition, ServerEvent, AgentTurn } from "../../types.js";
import type { StreamChunk } from "../../providers/adapter/types.js";

/**
 * One fixture file. Loaded from JSON on disk.
 */
export interface Fixture {
  /** Human-readable name; printed in the runner header. */
  name: string;
  /** Optional one-line description of what this fixture verifies. */
  description?: string;

  /** Inputs to feed the agent loop. */
  input: FixtureInput;

  /**
   * Model-response sequences, one per iteration. The replay adapter
   * yields responses[iteration] on each model call. If the loop runs
   * more iterations than provided sequences, the adapter yields an
   * `error` chunk (caught as "fixture exhausted").
   */
  responses: StreamChunk[][];

  /** Programmatic assertions that must hold after the turn ends. */
  expect: FixtureExpect;
}

export interface FixtureInput {
  userMessage: string;
  systemPrompt: string;
  /**
   * Tool definitions the agent has access to. Tool implementations
   * inside the fixture are NOT real — they're just stubs that return
   * the canned `toolResults` value. This avoids spawning subprocesses
   * or hitting filesystems during eval runs.
   */
  tools: FixtureTool[];
  /** Optional pre-conversation history. */
  history?: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCallId?: string }>;
  /** Defaults to "end_turn"-friendly settings. Override for ceiling tests. */
  maxIterations?: number;
}

/**
 * Tool stub for the fixture. The implementation just returns a canned
 * result string — no real side effects.
 */
export interface FixtureTool {
  definition: ToolDefinition;
  /**
   * Map of tool_call_id → result string. The runner builds tool
   * results from these when the agent invokes the tool. If a call
   * lands without a matching id, the runner falls back to the
   * `defaultResult` field.
   */
  results?: Record<string, string>;
  defaultResult?: string;
}

export interface FixtureExpect {
  /** Final stop reason. Defaults to "end_turn" if omitted. */
  stopReason?: AgentTurn["stopReason"];
  /** Substring or full match expected in the final assistant text. */
  assistantContains?: string[];
  /** Number of tool calls the loop should have routed through. */
  toolCallsCount?: number;
  /** Specific tool names the loop must have invoked (in any order). */
  toolNames?: string[];
  /** Substrings that must NOT appear in the final assistant text. */
  assistantNotContains?: string[];
  /** Optional explicit error-message check (when stopReason is "error"). */
  errorMessageContains?: string;
}

/**
 * Result of running a fixture through ONE loop variant.
 */
export interface RunResult {
  variant: "legacy" | "unified";
  turn: AgentTurn;
  toolCallsObserved: Array<{ name: string; arguments: string }>;
  /** All ServerEvents the loop emitted via onEvent. */
  events: ServerEvent[];
  /** Wall-clock duration. */
  durationMs: number;
  /** Iteration count the loop completed. */
  iterations: number;
  /** First failure reason if assertions didn't hold; null on success. */
  assertionFailure: string | null;
}

/**
 * Diff between the two loop variants. The runner prints this last —
 * green if zero diffs, red with the deltas otherwise.
 */
export interface ParityResult {
  fixtureName: string;
  legacy: RunResult;
  unified: RunResult;
  /** Each diff line is human-readable: "stopReason: legacy=end_turn unified=error". */
  diffs: string[];
  /** True when both ran to completion AND assertions passed AND zero diffs. */
  pass: boolean;
}

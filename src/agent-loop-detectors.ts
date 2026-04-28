// Post-turn validation detectors.
//
// When the model emits a response, SAX used to treat it as terminal: any
// emitted text → return end_turn, we're done. That's wrong. A turn can be
// incomplete in several distinct ways that look like a clean exit:
//   - Planning-only: "I'll do X next" with zero tool calls
//   - Single-exploratory-tool-then-stop: agent ran `ls`/`read` once and
//     promised continuation but stopped
//   - Reasoning-only: reasoning tokens emitted, no user-visible text
//   - Empty response: zero text + zero tools + zero tokens (provider hiccup)
//   - Uncommitted turn: made tool calls but none of them committed anything
//   - Stale evidence: running the same queries with no new information
//
// Each detector is a pure function that returns either null (turn is fine)
// or a RetryInstruction (inject this nudge, continue the loop). The agent
// loop runs these in order before returning end_turn; any firing detector
// short-circuits the exit.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { isCommittingTool } from "./committing-tool-check.js";

export type DetectorKind =
  | "planning-only"
  | "single-action-stop"
  | "reasoning-only"
  | "empty-response"
  | "uncommitted-turn"
  | "evidence-stale";

export interface RetryInstruction {
  kind: DetectorKind;
  instruction: string;
}

// ── Retry instructions ────────────────────────────────────────────────────
// Strings injected into the next attempt's system context. Kept as named
// exports so callers can also use them for telemetry/audit.

export const PLANNING_ONLY_INSTRUCTION =
  "Your previous reply described a plan but did not call any tools. Do not restate the plan. Take the first concrete tool action now. If a real blocker prevents action, state the exact blocker in one sentence.";

export const SINGLE_ACTION_STOP_INSTRUCTION =
  "Your previous reply ran one exploratory tool (read/list/search/glob) and implied more work would follow, but then stopped. Continue now with the next concrete action — save the file, call the write/edit tool, whatever the next step is. Do not re-explore. Do not summarize. Act.";

export const REASONING_ONLY_INSTRUCTION =
  "Your previous attempt recorded reasoning but did not produce a user-visible reply. Continue from the partial state and produce the visible answer now. Do not restart from scratch.";

export const EMPTY_RESPONSE_INSTRUCTION =
  "Your previous attempt produced no visible reply and no tool calls. Continue from current state and produce a visible answer or take the next concrete tool action.";

export const UNCOMMITTED_TURN_INSTRUCTION =
  "You called tools but none of them committed the change the user asked for. Call the tool that actually commits work now (write/edit/send/save/pin/deploy — whichever matches the request). Exploration is done.";

export const EVIDENCE_STALE_INSTRUCTION =
  "You have been reading and searching without new findings for several rounds. Either take a different approach (different tool, different args, different source) or tell the user the exact blocker in one sentence. Do not repeat the same queries.";

// ── Patterns ──────────────────────────────────────────────────────────────

const PLANNING_FUTURE_PROMISE =
  /\b(?:i(?:'ll| will)|i(?:'m| am)\s+going\s+to|let\s+me|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will))\b/i;

const ACTION_VERB =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|save|add|create|build|send|post|publish|deploy|remove|delete)\b/i;

const CONTINUATION_CUE =
  /\b(?:next|then|after(?:wards)?|once|subsequently|following\s+this)\b/i;

// Reply openers that signal "this is a recap of completed work, not a plan".
// When the first non-whitespace token is one of these, planning-only must not
// fire — incidental "I'll restart the server" follow-up notes inside a recap
// are not future promises that need re-engagement.
const COMPLETION_OPENER =
  /^\s*(?:[*_`#>-]\s*)?(?:Done|Shipped|Fixed|Patched|All\s+(?:set|three|fixed|done|good)|Patch\s+(?:landed|applied|shipped|in)|Build\s+(?:passed|ok|complete|green)|Recap|Summary)\b/i;

// Signals that the agent is legitimately blocked waiting for user input.
// When any of these fire, all the "you didn't do enough" retry detectors must
// stand down — forcing the agent to keep working when it's blocked just
// respawns the same browser/tool churn with no new input to act on.
//
// This regex looks for three things the agent says in genuine-blocker replies:
//   1. Sentence-initial imperative asking the user to do something
//      ("Send me the invoice", "Drop the file", "Paste the link")
//   2. Explicit requests/conditions ("can you send", "when you're ready",
//      "let me know when", "tell me when")
//   3. Agent-flagged need for input ("I need the ...", "Before I can ...")
//
// It deliberately does NOT match first-person promises like "I'll send the
// email" — those should still trigger planning-only retries when appropriate.
const WAITING_ON_USER =
  /(?:^|[.!?—–:;]\s*|\n)\s*(?:please\s+|kindly\s+)?(?:send|share|paste|drop|upload|attach|provide|post|give|show)\s+(?:me|the|it|us|your|a)\b|(?:can|could|would)\s+you\s+(?:send|share|paste|drop|upload|attach|provide|post|give|show|tell|let)\b|when\s+you(?:'re| are)?\s+(?:ready|done|have|get|finish)|let\s+me\s+know\s+(?:when|once|if)|tell\s+me\s+(?:when|once|if|what|who|where|how|the|your)|\bi\s+need\s+(?:the|your|more|you\s+to)\b|\bbefore\s+i\s+(?:can|proceed|continue|start)\b|\bonce\s+you\s+(?:send|share|provide|tell|have|do|'ve|are)\b|\bdrop\s+(?:it|them|that|the)\b/i;

/**
 * True if the agent's reply clearly signals it is blocked waiting on the user.
 * When true, the post-turn detectors must NOT fire — "keep going" is wrong
 * when there's nothing to keep going on.
 */
export function isWaitingOnUser(text: string): boolean {
  if (!text) return false;
  return WAITING_ON_USER.test(text);
}

const RETRY_SAFE_EXPLORATORY_TOOLS = new Set([
  "read",
  "bash",
  "list_files",
  "ls",
  "search",
  "find",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
]);

// ── Detector inputs ───────────────────────────────────────────────────────

export interface TurnState {
  /** Assistant's final visible text this attempt. */
  assistantText: string;
  /** Tool calls the model emitted this attempt. */
  toolCallsThisIteration: Array<{ name: string; arguments?: string }>;
  /** Every tool name called across the full turn (not just this iteration). */
  toolsCalledThisTurn: Set<string>;
  /** True if the model produced any reasoning tokens this attempt. */
  hasReasoning: boolean;
  /** Total completion tokens this attempt (provider-reported). */
  completionTokens: number;
  /** Number of iterations the turn has already run. */
  iteration: number;
  /** Evidence counter (filesRead + searches + tool results + edits). */
  evidenceCount: number;
  /** Evidence count at the start of each iteration — used for staleness. */
  evidenceHistory: number[];
  /**
   * True if the latest user message included an image attachment. When set,
   * the orchestrator skips planning-only / uncommitted-turn / evidence-stale
   * detectors — those misfire on vision replies. The agent's "this is what
   * I see in the picture" is a complete answer, not a stalled plan, but it
   * looks like one to the regex-based detectors and triggers a retry storm
   * (3+ near-identical reply restatements per turn).
   */
  userMessageHasImages?: boolean;
}

/**
 * True if any user message in the array carries an image_url part. Callers
 * pass this through to TurnState.userMessageHasImages.
 */
export function userMessageHasImages(messages: Array<{ role: string; content: unknown }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string }>) {
        if (part?.type === "image_url" || part?.type === "image") return true;
      }
    }
    return false; // most recent user message decides — older ones don't matter
  }
  return false;
}

// ── Detectors ─────────────────────────────────────────────────────────────

/** Model promised future action but made no tool call. */
export function detectPlanningOnly(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (!state.assistantText) return null;
  const text = state.assistantText;
  // Recap-style completion replies (e.g. "Done. Recap: ...", "Patch landed",
  // "All three fixes are in place") often contain incidental "I'll restart
  // the server" notes that trip the planning regexes. If a committing tool
  // ran this turn AND the reply opens with a completion marker, it's a
  // legitimate recap, not a plan.
  if (COMPLETION_OPENER.test(text)) {
    for (const name of state.toolsCalledThisTurn) {
      if (isCommittingTool(name)) return null;
    }
  }
  if (!PLANNING_FUTURE_PROMISE.test(text)) return null;
  if (!ACTION_VERB.test(text)) return null;
  return { kind: "planning-only", instruction: PLANNING_ONLY_INSTRUCTION };
}

/**
 * Model ran ONE exploratory read tool, then emitted a continuation promise
 * but didn't follow through. This is the numberblocks-style bug.
 */
export function detectSingleActionStop(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length !== 1) return null;
  const onlyCall = state.toolCallsThisIteration[0];
  if (!RETRY_SAFE_EXPLORATORY_TOOLS.has(onlyCall.name)) return null;
  if (!state.assistantText) return null;
  // Needs either a future-promise phrase OR a continuation cue right after
  // the exploratory tool's summary.
  if (!PLANNING_FUTURE_PROMISE.test(state.assistantText) && !CONTINUATION_CUE.test(state.assistantText)) {
    return null;
  }
  return { kind: "single-action-stop", instruction: SINGLE_ACTION_STOP_INSTRUCTION };
}

/** Model emitted reasoning tokens but no user-visible text. */
export function detectReasoningOnly(state: TurnState): RetryInstruction | null {
  if (!state.hasReasoning) return null;
  if (state.assistantText && state.assistantText.trim().length > 0) return null;
  if (state.toolCallsThisIteration.length > 0) return null;
  return { kind: "reasoning-only", instruction: REASONING_ONLY_INSTRUCTION };
}

/** Model emitted nothing at all — empty text, no tools, zero tokens. */
export function detectEmptyResponse(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (state.assistantText && state.assistantText.trim().length > 0) return null;
  if (state.hasReasoning) return null; // reasoning-only detector handles this
  if (state.completionTokens > 0) return null; // tokens produced but not visible — different issue
  return { kind: "empty-response", instruction: EMPTY_RESPONSE_INSTRUCTION };
}

/**
 * Turn is ending (no tools this iteration) but no committing tool was
 * called in the whole turn. This catches the "ran exploratory tools,
 * never actually did the work" pattern.
 */
export function detectUncommittedTurn(state: TurnState): RetryInstruction | null {
  if (state.toolCallsThisIteration.length > 0) return null;
  if (state.iteration === 0) return null; // iter 0 with no tools is handled by planning-only + empty-response
  let hasCommit = false;
  for (const name of state.toolsCalledThisTurn) {
    if (isCommittingTool(name)) { hasCommit = true; break; }
  }
  if (hasCommit) return null;
  // Only nudge once per turn for this class; caller tracks the counter.
  return { kind: "uncommitted-turn", instruction: UNCOMMITTED_TURN_INSTRUCTION };
}

/**
 * Evidence counter flat for 2+ rounds AND no committing tool was called
 * in that window. Prevents endless exploration.
 */
export function detectEvidenceStale(state: TurnState): RetryInstruction | null {
  const history = state.evidenceHistory;
  if (history.length < 3) return null;
  const last = history[history.length - 1];
  const prior1 = history[history.length - 2];
  const prior2 = history[history.length - 3];
  if (last !== prior1 || prior1 !== prior2) return null;
  let hasCommit = false;
  for (const name of state.toolsCalledThisTurn) {
    if (isCommittingTool(name)) { hasCommit = true; break; }
  }
  if (hasCommit) return null;
  return { kind: "evidence-stale", instruction: EVIDENCE_STALE_INSTRUCTION };
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export interface RetryBudget {
  planningOnly: number;
  singleActionStop: number;
  reasoningOnly: number;
  emptyResponse: number;
  uncommittedTurn: number;
  evidenceStale: number;
}

export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  planningOnly: 2,
  singleActionStop: 2,
  reasoningOnly: 2,
  emptyResponse: 2,
  uncommittedTurn: 1,
  evidenceStale: 1,
};

export interface RetryCounters {
  planningOnly: number;
  singleActionStop: number;
  reasoningOnly: number;
  emptyResponse: number;
  uncommittedTurn: number;
  evidenceStale: number;
}

export function createRetryCounters(): RetryCounters {
  return {
    planningOnly: 0,
    singleActionStop: 0,
    reasoningOnly: 0,
    emptyResponse: 0,
    uncommittedTurn: 0,
    evidenceStale: 0,
  };
}

/**
 * Run detectors in order, return the first firing instruction whose budget
 * still has room. Order matters — earlier detectors catch more specific
 * patterns, later ones are broader fallbacks.
 */
export function runPostTurnDetectors(
  state: TurnState,
  counters: RetryCounters,
  budget: RetryBudget = DEFAULT_RETRY_BUDGET,
): RetryInstruction | null {
  // Short-circuit: if the agent's reply signals it's waiting on user input
  // (asking for a file, credentials, a decision, etc.), none of the "do more
  // work" detectors are appropriate. Forcing another iteration just respawns
  // the browser/tools with nothing new to act on.
  if (isWaitingOnUser(state.assistantText)) return null;

  // Image-context exemption: when the user attached an image, the agent's
  // expected reply is a description / answer, not an action plan. The three
  // detectors below regex-match on phrases that read as "I'll do X" — but
  // a sentence like "I see X in the image; you could try Y" matches that
  // shape too, even though it's a complete answer. Empty-response / reasoning-
  // only / single-action-stop are still safe to run because they catch
  // genuinely broken paths (no text + no tools, etc.).
  const skipImageMisfiringDetectors = state.userMessageHasImages === true;

  const checks: Array<{ run: (s: TurnState) => RetryInstruction | null; key: keyof RetryCounters }> = [
    { run: detectPlanningOnly,       key: "planningOnly" },
    { run: detectSingleActionStop,   key: "singleActionStop" },
    { run: detectReasoningOnly,      key: "reasoningOnly" },
    { run: detectEmptyResponse,      key: "emptyResponse" },
    { run: detectUncommittedTurn,    key: "uncommittedTurn" },
    { run: detectEvidenceStale,      key: "evidenceStale" },
  ];
  const IMAGE_MISFIRE_KEYS = new Set<keyof RetryCounters>(["planningOnly", "uncommittedTurn", "evidenceStale"]);
  for (const { run, key } of checks) {
    if (skipImageMisfiringDetectors && IMAGE_MISFIRE_KEYS.has(key)) continue;
    const hit = run(state);
    if (!hit) continue;
    if (counters[key] >= budget[key]) continue;
    counters[key] += 1;
    return hit;
  }
  return null;
}

// ── Evidence counting ─────────────────────────────────────────────────────
//
// Lightweight evidence model: count tool results that look like they
// advanced the state. Read operations, searches, lists, and any writes.
// Dead-ends and empty results don't count.

const EVIDENCE_TOOLS = new Set([
  "read", "bash", "list_files", "ls", "search", "find", "grep", "glob",
  "web_fetch", "web_search", "write", "edit", "http_request",
]);

/**
 * Scan turn messages for evidence-generating tool calls with non-empty
 * results. Returns a count. Caller diffs this across iterations to detect
 * staleness.
 */
export function computeEvidenceCount(messages: ChatCompletionMessageParam[]): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      const name = tc.function?.name || "";
      if (!EVIDENCE_TOOLS.has(name)) continue;
      count += 1;
    }
  }
  return count;
}

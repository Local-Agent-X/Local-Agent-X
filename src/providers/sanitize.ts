import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { chatHistoryMaxKeep } from "../context-manager/compaction-policy.js";
import { stripSystemInjectionTags } from "../sanitize.js";
import { truncateHistory } from "./truncate-history.js";

// Working-window truncation + CM-2 digest live in ./truncate-history.ts
// (split for the 400-LOC gate). Re-exported here so existing importers keep
// working; this file remains the canonical sanitization seam.
export { truncateHistory, awaitPendingHistorySummaries } from "./truncate-history.js";

/** Sanitize tool result content to remove pseudo-system injection tags. */
export function sanitizeToolResults(results: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return results.map(r => {
    if (r.role !== "tool" || typeof r.content !== "string") return r;
    return { ...r, content: stripSystemInjectionTags(r.content) };
  });
}

// ── Control-marker invariant ────────────────────────────────────────────────
//
// INVARIANT: message `content` holds only what a speaker actually said.
// Control-plane facts ABOUT a message (it was interrupted, it made tool
// calls, it failed) travel as structured fields (`_interrupted`, `_error`,
// like `_ephemeral`), never as inline text — a text marker in history is
// language the model reads and will eventually imitate. This has now bitten
// twice: the "[Tool calls this turn: …]" marker (removed from voice-ws) and
// the " [interrupted by user]" marker, which Grok echoed into a single
// assistant message containing 763 copies.
//
// This seam is the single enforcement point (every provider-bound history
// passes through buildCleanHistory → sanitizeHistory):
//  1. `_interrupted: true` / `_error: { code, message }` on a stored
//     assistant message render here — once each, canonically, as
//     INTERRUPTED_TURN_BOUNDARY / the turn-error boundary appended to that
//     message's provider-bound copy. Stored content and the UI transcript
//     stay clean.
//  2. Known marker text found INSIDE assistant content (legacy sessions
//     written before the flag, or model echoes of the markers) is scrubbed,
//     so polluted sessions self-heal instead of re-seeding the loop each turn.
//  3. A message whose content IS exactly a boundary sentence is the chat
//     path's deliberate standalone boundary row — kept verbatim.

/**
 * The one canonical rendering of "this turn was cut short" for the model.
 * Full-sentence and instruction-shaped on purpose: short bracketed tokens
 * inline with speech (the old voice marker) are what models pattern-match
 * and spam. Owned here; canonical-run.ts imports it for the chat path.
 */
export const INTERRUPTED_TURN_BOUNDARY =
  "[Previous turn was interrupted before it finished. The work above ran; continue from there.]";

/**
 * The one canonical rendering of "this turn ended with a terminal error" —
 * INTERRUPTED_TURN_BOUNDARY's sibling for a turn that died on a provider or
 * loop error the UI already showed (a 400, an exhausted retry streak, a
 * deadline). Without it the next turn's model sees a clean history plus "you
 * errored out" and re-does the work instead of explaining. Same discipline:
 * full-sentence, instruction-shaped, never a short bracketed token. The
 * payload varies, so the frame is HEAD/TAIL and `renderTurnErrorBoundary` is
 * the single writer; canonical-run.ts uses it for the chat path's standalone
 * `_error` boundary row, and the seam below re-renders from the flag.
 */
export interface TurnError { code: string; message: string }
export const TURN_ERROR_BOUNDARY_HEAD = "[The previous assistant turn ended with an error (";
export const TURN_ERROR_BOUNDARY_TAIL =
  "). Work completed before the error stands; do not repeat side-effecting actions — explain the error to the user and continue from the current state.]";

export function renderTurnErrorBoundary(err: TurnError): string {
  const code = err.code.replace(/\s+/g, " ").trim() || "error";
  const message = err.message.replace(/\s+/g, " ").trim();
  return `${TURN_ERROR_BOUNDARY_HEAD}${code}: ${message}${TURN_ERROR_BOUNDARY_TAIL}`;
}

function asTurnError(v: unknown): TurnError | null {
  if (!v || typeof v !== "object") return null;
  const { code, message } = v as Record<string, unknown>;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

// Model echoes of an error boundary embedded in speech. The payload varies,
// so match the fixed frame around a bounded single-line body; like
// CONTROL_MARKERS, tolerates a model-mangled copy missing its closing bracket.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One shared body bound for the echo scrub and the standalone recognition. */
const TURN_ERROR_BODY_BOUND = 400;
const TURN_ERROR_ECHO = new RegExp(
  `\\s*${escapeRe(TURN_ERROR_BOUNDARY_HEAD)}.{0,${TURN_ERROR_BODY_BOUND}}?${escapeRe(TURN_ERROR_BOUNDARY_TAIL.slice(0, -1))}\\]?`,
  "g",
);

// A standalone `_error` boundary row is ALSO recognized by content — the
// structural flag can be dropped by copy paths — but recognition is
// deliberately STRICT, because a kept row is permanent while a scrubbed one
// merely degrades to the pre-recognition behavior (narration lost). So:
//  - the body must have renderTurnErrorBoundary's template shape — a bare
//    `code: message` with code ≤64 chars of [A-Za-z0-9_.-] and a single-line,
//    bracket-free message — so prose or bracketed payloads smuggled into the
//    frame fail recognition and fall through to the echo scrub;
//  - the bracket-free body also makes a multi-copy concatenation structurally
//    unmatchable (HEAD contains `[`, TAIL contains `]`), and
//    isStandaloneTurnErrorBoundary rejects any second HEAD explicitly;
//  - sanitizeHistory adds the history-level rule: content recognition only
//    applies when NO control-flagged row exists in the pass (flags re-render
//    boundaries, so a flagless frame beside one is an echo), and only to the
//    LAST matching row. When in doubt, scrub.
const TURN_ERROR_STANDALONE = new RegExp(
  `^${escapeRe(TURN_ERROR_BOUNDARY_HEAD)}[A-Za-z0-9_.-]{1,64}: [^\\[\\]\\r\\n]{0,${TURN_ERROR_BODY_BOUND}}?${escapeRe(TURN_ERROR_BOUNDARY_TAIL)}$`,
);

/** True iff `trimmed` is EXACTLY one canonically-shaped `_error` boundary. */
function isStandaloneTurnErrorBoundary(trimmed: string): boolean {
  // A second HEAD anywhere = concatenated echo copies, never one canonical row.
  if (trimmed.indexOf(TURN_ERROR_BOUNDARY_HEAD, 1) !== -1) return false;
  return TURN_ERROR_STANDALONE.test(trimmed);
}

// Registry of retired inline markers to scrub from assistant content.
// Add new entries here if another marker is ever found in the wild — and
// then go delete its writer, because writing one is the actual bug.
// `meansInterrupted` markers re-render as the canonical boundary; others
// scrub silently. Patterns tolerate model-mangled unclosed copies.
const CONTROL_MARKERS: Array<{ pattern: RegExp; meansInterrupted: boolean }> = [
  // Voice barge-in marker (writer removed 2026-07; legacy sessions + echoes).
  { pattern: /\s*\[interrupted by user\]?/g, meansInterrupted: true },
  // Tool-trace marker (writer removed 2026-06; legacy sessions may carry it).
  { pattern: /\s*\[Tool calls this turn:[^\]\n]*\]?/g, meansInterrupted: false },
];

/**
 * Enforce the control-marker invariant on one provider-bound message.
 * Returns the message unchanged when nothing applies (common case).
 */
function enforceMarkerInvariant(
  m: ChatCompletionMessageParam,
  keepFlaglessErrorBoundary = false,
): ChatCompletionMessageParam {
  if (m.role !== "assistant" || typeof m.content !== "string") return m;
  const rec = m as unknown as Record<string, unknown>;
  const turnError = asTurnError(rec._error);
  const errorBoundary = turnError ? renderTurnErrorBoundary(turnError) : null;

  // The chat path's deliberate standalone boundary rows: keep as-is, minus
  // the structural flag (provider payloads carry only role/content shape).
  // A flagless `_error` frame is kept ONLY when sanitizeHistory nominated
  // this row (no control-flagged sibling anywhere in the history, and this
  // is the last matching row); every other flagless frame is an echo and
  // falls through to the scrub below.
  const trimmed = m.content.trim();
  if (
    trimmed === INTERRUPTED_TURN_BOUNDARY ||
    (errorBoundary !== null && trimmed === errorBoundary) ||
    (keepFlaglessErrorBoundary && isStandaloneTurnErrorBoundary(trimmed))
  ) {
    if (rec._interrupted === undefined && rec._error === undefined) return m;
    return withoutControlFlags(m);
  }

  let interrupted = rec._interrupted === true;
  let content = m.content;
  for (const { pattern, meansInterrupted } of CONTROL_MARKERS) {
    pattern.lastIndex = 0;
    if (!pattern.test(content)) continue;
    if (meansInterrupted) interrupted = true;
    pattern.lastIndex = 0;
    content = content.replace(pattern, "");
  }
  // Model echoes of the boundary sentences embedded inside speech.
  while (content.includes(INTERRUPTED_TURN_BOUNDARY)) {
    content = content.replace(INTERRUPTED_TURN_BOUNDARY, "");
  }
  content = content.replace(TURN_ERROR_ECHO, "");

  if (content === m.content && !interrupted && errorBoundary === null) return m;

  // Render each control fact once, canonically, on the provider copy.
  content = content.trim();
  if (interrupted) {
    content = content ? `${content}\n\n${INTERRUPTED_TURN_BOUNDARY}` : INTERRUPTED_TURN_BOUNDARY;
  }
  if (errorBoundary !== null) {
    content = content ? `${content}\n\n${errorBoundary}` : errorBoundary;
  }
  return withoutControlFlags({ ...m, content } as ChatCompletionMessageParam);
}

/** Provider copy without the structural control flags (shallow copy). */
function withoutControlFlags(m: ChatCompletionMessageParam): ChatCompletionMessageParam {
  const copy = { ...m } as ChatCompletionMessageParam;
  const rec = copy as unknown as Record<string, unknown>;
  delete rec._interrupted;
  delete rec._error;
  return copy;
}

/**
 * Strip ephemeral self-check / quality-gate / middleware-nudge user messages
 * before persisting a session.
 *
 * Two filter mechanisms (defense-in-depth):
 *  1. Structural — `_ephemeral: true` flag set by agent-loop/run.ts on every
 *     middleware nudge push. New nudges are auto-filtered without anyone
 *     having to remember to update a string list.
 *  2. Legacy strings — covers nudges that were saved before the flag existed,
 *     plus self-check / quality-gate messages that aren't routed through the
 *     middleware nudge path.
 *
 * The model still sees the nudge during the turn (it's in the in-memory
 * messages array). The flag only kicks in at persist + replay boundaries so
 * the chat transcript on reload doesn't show purple "You claimed..." bubbles
 * where tool calls used to render live.
 */
export function stripEphemeralMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.filter((m) => {
    // Structural marker — set on every middleware nudge in agent-loop/run.ts
    if ((m as unknown as { _ephemeral?: boolean })._ephemeral === true) return false;

    if (m.role === "user" && typeof m.content === "string") {
      if (m.content.startsWith("[Self-check]")) return false;
      if (m.content.startsWith("Your previous response was empty.")) return false;
      if (m.content.startsWith("Tool errors occurred but you did not address them.")) return false;
      if (m.content.startsWith("You do NOT need approval.")) return false;
      // Action-claim / force-tool-use nudges. Listed by exact prefix because
      // older sessions on disk pre-date the _ephemeral flag — those messages
      // need to be filtered on load too.
      if (m.content.startsWith("You claimed to have created or scheduled")) return false;
      if (m.content.startsWith("You claimed to have added/updated/created/scheduled")) return false;
      if (m.content.startsWith("You claimed an action ")) return false;
      // NOTE: "SYSTEM: You have called ..." loop nudges are kept — the LLM must see them to stop looping
    }
    // Strip legacy empty-response placeholders so they don't pollute
    // future turns (breaks alternating-role expectation on Codex API).
    if (m.role === "assistant" && typeof m.content === "string") {
      if (m.content.includes("model returned an empty response") && m.content.length < 300) return false;
    }
    return true;
  });
}

/**
 * Sanitize a message history before sending it to a provider.
 * Strips orphaned tool_calls (assistant tool_calls without matching tool results)
 * and orphaned tool results (tool messages without matching assistant calls),
 * and enforces the control-marker invariant (see block comment above).
 *
 * The OpenAI Responses API in particular silently rejects requests with
 * malformed tool_call structure — the model returns zero output items, which
 * shows up as an empty response. This is the root cause of the bridge handler
 * returning empty placeholders even for benign messages like "hey".
 */
export function sanitizeHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  type MsgRecord = Record<string, unknown>;
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      for (const tc of rec.tool_calls as Array<{ id: string }>) callIds.add(tc.id);
    }
    if (m.role === "tool" && rec.tool_call_id) {
      resultIds.add(rec.tool_call_id as string);
    }
  }
  const orphanedCallIds = new Set([...callIds].filter((id) => !resultIds.has(id)));

  // Nominate at most ONE flagless standalone `_error` boundary row for
  // content recognition (the genuine flag-dropped copy). When ANY control-
  // flagged row is present, the seam re-renders boundaries from flags, so a
  // flagless frame beside one is a model echo — none is nominated and the
  // echo scrub applies (sessions self-heal). With no flagged sibling, only
  // the LAST matching row can be the genuine copy; earlier ones are echoes.
  const anyControlFlagged = messages.some((m) => {
    const rec = m as unknown as MsgRecord;
    return rec._interrupted === true || asTurnError(rec._error) !== null;
  });
  let keepFlaglessBoundaryIdx = -1;
  if (!anyControlFlagged) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      if (isStandaloneTurnErrorBoundary(m.content.trim())) {
        keepFlaglessBoundaryIdx = i;
        break;
      }
    }
  }

  const out: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i];
    const m = enforceMarkerInvariant(raw, i === keepFlaglessBoundaryIdx);
    const rec = m as unknown as MsgRecord;
    if (m.role === "assistant" && rec.tool_calls) {
      if (orphanedCallIds.size > 0) {
        const cleaned = (rec.tool_calls as Array<{ id: string }>).filter((tc) => !orphanedCallIds.has(tc.id));
        if (cleaned.length === 0) {
          if (m.content) out.push({ role: m.role, content: m.content } as ChatCompletionMessageParam);
        } else {
          out.push({ ...m, tool_calls: cleaned } as typeof m);
        }
      } else {
        out.push(m);
      }
    } else if (m.role === "tool") {
      const tid = rec.tool_call_id as string | undefined;
      if (tid && callIds.has(tid) && !orphanedCallIds.has(tid)) {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }

  // Coalesce consecutive same-role text messages. Multiple bridge messages
  // arriving back-to-back with no agent reply (3x "hey") create runs of
  // user-only messages that violate the alternating-role expectation Codex
  // enforces and cause empty responses.
  const coalesced: ChatCompletionMessageParam[] = [];
  for (const m of out) {
    const last = coalesced[coalesced.length - 1];
    if (
      last &&
      last.role === m.role &&
      (m.role === "user" || m.role === "assistant") &&
      typeof last.content === "string" &&
      typeof m.content === "string" &&
      !(last as unknown as MsgRecord).tool_calls &&
      !(m as unknown as MsgRecord).tool_calls
    ) {
      // Merge into the previous message — on a COPY. `last` is often the live
      // session.messages row (callers pass stored history uncopied and
      // enforceMarkerInvariant returns the original when nothing applies);
      // mutating it would persist the merged text into stored history and the
      // reloaded transcript would show the boundary sentence twice.
      coalesced[coalesced.length - 1] = { ...last, content: `${last.content}\n${m.content}` } as ChatCompletionMessageParam;
      continue;
    }
    coalesced.push(m);
  }
  return coalesced;
}

// Build a chat turn's cleanHistory from raw session messages: sanitize
// provider-illegal shapes, then keep the most recent `maxKeep` (40 for web
// chat, 30 otherwise). Lives here next to its two building blocks so the resume
// path (run-chat-turn orchestrator, after a turn-lock replace) can rebuild
// cleanHistory from freshly-salvaged session.messages WITHOUT pulling in the
// heavy prepare-request pipeline. `prepared` snapshots history before the lock
// awaits the prior turn's salvage, so this refresh is what lets a same-instant
// "keep going" see the interrupted turn's work instead of re-deriving it.
export function buildCleanHistory(
  sessionMessages: ChatCompletionMessageParam[],
  channel: string,
  maxHistory?: number,
): ChatCompletionMessageParam[] {
  const maxKeep = maxHistory || chatHistoryMaxKeep(channel);
  return truncateHistory(sanitizeHistory(sessionMessages), maxKeep);
}

/**
 * Unresolved-tool-intent gate (decision half; the CompletionGate wrapper that
 * appends the nudge lives in decide-outcome-gates.ts like every sibling's).
 *
 * Invariant: a turn cannot complete while its final assistant text contains
 * recognized tool-call SYNTAX. The 2026-09-08 muse-glimmer:30b incident: the
 * model ended a turn with `<atem:function_calls><atem:invoke name="grep">…`
 * as its final text — nothing ran, and the turn closed as if done. The
 * adapters' text-extractor promotes what it can DURING the turn and EXCISES
 * every promoted range from the text, so any recognized range still in the
 * final text at decision time is, by construction, a call that did not
 * happen — whether or not other calls in the same turn did run. The gate
 * therefore decides on ranges alone; there is no dispatched-calls exemption
 * (one would let a promoted `read` mask a truncated `write` leak). Purely
 * syntactic (tool-call-text-syntaxes is THE recognizer), on the code-span
 * masked view so a backticked example is never a leak — no prose heuristics.
 *
 * Bounded like its siblings: the first fire re-opens the turn with the
 * canonical WIRE_FORMAT_NUDGE at turn+1; every later fire on the same op lets
 * the turn end but hands decide-outcome an honest terminal message so the user
 * sees that nothing executed instead of a silent "done". (A later gate may
 * re-open after the second fire, so the terminal states the actual count.)
 * Per-op state lives in the middleware-state registry (auto-dropped on op
 * terminal, exactly like the interactive empty-turn counter in
 * empty-turn-termination.ts).
 *
 * Module-graph note: decide-outcome-gates.ts builds its table at module-eval
 * time from gates.ts-local objects and calls into this module only lazily
 * (inside evaluate), so this file may be an import entry point without
 * tripping the table — that is why the wrapper is not exported from here.
 */
import { createLogger } from "../../logger.js";
import { getMiddlewareState } from "../middlewares/state.js";
import { getToolsForOp } from "../runtime.js";
import {
  findTextToolCallRanges,
  resolveCandidateName,
  scanTextToolCallSyntaxes,
  type ScanOptions,
} from "../adapters/tool-call-text-syntaxes.js";
import type { CompletionGateContext } from "./decide-outcome-gates.js";
import { WIRE_FORMAT_NUDGE } from "./nudges.js";

const logger = createLogger("canonical-loop.tool-intent-gate");

const TOOL_INTENT_GATE_KEY = "unresolved-tool-intent-fires";

/** ONE view for both scans: the range verdict and the name lookup must see
 *  the same text, or a quoted example could name the honest terminal. */
const SCAN: ScanOptions = { maskCodeSpans: true };

export interface ToolIntentGateResult {
  /** Nudge for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done" for one retry. */
  shouldRetry: boolean;
  /** Repeat fire: the user-facing terminal the turn must end WITH (never alongside a retry). */
  honestTerminal?: string;
}

const NO_RETRY: ToolIntentGateResult = { nudge: "", shouldRetry: false };

/**
 * The tool the leaked text was trying to call, for the honest terminal: the
 * first hit that carried a candidate, resolved against the op's tool set when
 * one is registered (so a namespaced/cased variant names the real tool), the
 * raw candidate name otherwise. Null when no block carried a usable name.
 */
function leakedToolName(text: string, validNames: Set<string>): string | null {
  for (const hit of scanTextToolCallSyntaxes(text, SCAN)) {
    if (!hit.candidate) continue;
    const raw = hit.candidate.name.trim();
    if (validNames.size === 0) return raw || null;
    const resolved = resolveCandidateName(hit.candidate, validNames);
    if (resolved) return resolved;
  }
  return null;
}

export function honestToolIntentTerminal(tool: string | null, fires: number): string {
  const which = tool ? `the \`${tool}\` tool` : "a tool";
  return (
    `I tried to call ${which} but the call came out as text instead of a real call, ${fires} times. ` +
    `Nothing was executed. This model may not be handling tool calls reliably — ` +
    `try again, or switch to a different model.`
  );
}

/**
 * Decide whether this "done" turn's final text still holds an unexecuted
 * tool call. Contract (the wrapper enforces the entry gate):
 *   - Call only when terminalReason === "done".
 *   - Decides on recognized ranges in the final text alone — promoted ranges
 *     never survive there, so every one left is unresolved intent, even in a
 *     turn that also dispatched real calls.
 *   - First fire per op → one retry nudge; every later fire → honestTerminal.
 */
export function runToolIntentGate({ op, turnIdx, assistantText }: CompletionGateContext): ToolIntentGateResult {
  const validNames = new Set(getToolsForOp(op.id).map(t => t.name));
  const ranges = findTextToolCallRanges(assistantText, validNames, SCAN);
  if (ranges.length === 0) return NO_RETRY;

  const state = getMiddlewareState(op.id, TOOL_INTENT_GATE_KEY, () => ({ fires: 0 }));
  // Count the fire BEFORE anything fallible runs (spec-audit's ordering): a
  // throw mid-append must still consume this op's one retry.
  state.fires += 1;
  const tool = leakedToolName(assistantText, validNames);
  if (state.fires === 1) {
    logger.info(
      `op=${op.id} turn=${turnIdx} final text carries ${ranges.length} tool-call syntax block(s) ` +
      `(tool=${tool ?? "?"}) left unexecuted — re-opening with the wire-format nudge`,
    );
    return { nudge: WIRE_FORMAT_NUDGE, shouldRetry: true };
  }
  logger.warn(
    `op=${op.id} turn=${turnIdx} tool-call syntax leaked again after the wire-format nudge ` +
    `(fire=${state.fires} tool=${tool ?? "?"}) — ending the turn with an honest terminal`,
  );
  return { nudge: "", shouldRetry: false, honestTerminal: honestToolIntentTerminal(tool, state.fires) };
}

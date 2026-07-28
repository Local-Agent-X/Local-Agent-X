// Per-step reasoning-effort classification — single source for "does this
// step deserve the session's full thinking budget, or is it a mechanical
// continuation?". Today effort is one scalar frozen at adapter construction,
// so a long planning step and an 8s file-mechanics continuation get the same
// reasoning budget. This module classifies each step from the turn input the
// loop already builds; adapters MAY down-shift on the hint and must never
// up-shift. Anything ambiguous → "standard" (today's behavior).
//
// Kill switch: LAX_STEP_EFFORT=off → every step classifies "standard".

import type { TurnInput } from "./adapter-contract.js";
import {
  capEffort,
  DEFAULT_REASONING_EFFORT,
  type ReasoningEffort,
} from "../providers/reasoning-effort.js";

export type StepEffort = "standard" | "mechanical";

/**
 * File-mechanics tools whose results a model consumes without needing deep
 * deliberation to decide its next move. Names verified against the tool
 * definitions registered in src/tools/registry-build.ts:
 *   read, write            — src/tools/read-write-tools.ts
 *   edit, edit_lines,
 *   multi_edit             — src/tools/edit-tools.ts
 *   glob                   — src/tools/glob-tool.ts
 *   grep                   — src/tools/grep-tool.ts
 *   structural_search      — src/tools/structural-search-tool.ts
 * Deliberately narrow: bash, web_*, process_*, and every artifact tool stay
 * "standard" — their results routinely change the plan.
 */
export const MECHANICAL_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "multi_edit",
  "edit_lines",
  "structural_search",
]);

/**
 * Default routing floor for mechanical steps is "low", NOT "minimal": gpt-5.6
 * rejects minimal (see effortForCodexModel in src/codex-client/request.ts),
 * and "low" already buys the latency win without tripping that shim.
 * The ceiling is ADAPTER-SPECIFIC — an adapter whose endpoint degrades at
 * "low" passes a higher ceiling to resolveStepReasoningEffort (codex caps at
 * "medium"; see the call site in adapters/codex.ts).
 */
export const MECHANICAL_EFFORT_CEILING: ReasoningEffort = "low";

/**
 * Classify a step as mechanical iff:
 *   - no pendingRedirect (a redirect is a NEW USER INSTRUCTION the adapters
 *     append to the outgoing request OUTSIDE `messages` — see
 *     canonical-to-chat-param.ts / canonical-to-transport.ts — so the
 *     re-plan step must keep the full budget; the sibling user channels,
 *     mid-turn injects and nudges, land as trailing user rows and already
 *     classify standard via the trailing-batch rule), AND
 *   - turnIdx > 0 (turn 0 is always the planning step), AND
 *   - the trailing rows of `messages` are the pending tool_result batch
 *     (readOpMessages ordering — see build-input.ts), AND
 *   - every one of those results maps back (via the preceding assistant
 *     row's `content.toolCalls` — the shape both adapters finalize and
 *     canonical-to-chat-param.ts replays) to a tool in MECHANICAL_TOOLS, AND
 *   - every result carries status "ok" (dispatch-tools.ts stores the
 *     ToolDispatchStatus structurally on the row content as
 *     `{ toolCallId, result, status }` — no header parsing needed; a failed
 *     action — error/blocked/declined/timeout/cancelled — deserves full
 *     thinking).
 * Any missing/unmappable piece → "standard".
 */
export function classifyStepEffort(
  input: Pick<TurnInput, "turnIdx" | "messages" | "pendingRedirect">,
): StepEffort {
  if (process.env.LAX_STEP_EFFORT === "off") return "standard";
  if (input.pendingRedirect) return "standard";
  if (input.turnIdx <= 0) return "standard";

  // Trailing tool_result batch — walk back from the end.
  const messages = input.messages;
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === "tool_result") start--;
  if (start === messages.length) return "standard"; // no trailing batch
  if (start === 0) return "standard"; // no preceding assistant row

  const prev = messages[start - 1];
  if (prev.role !== "assistant") return "standard";
  const nameById = toolNamesById(prev.content);

  for (let i = start; i < messages.length; i++) {
    const c = messages[i].content as
      | { toolCallId?: unknown; status?: unknown }
      | null
      | undefined;
    if (!c || typeof c !== "object") return "standard";
    if (c.status !== "ok") return "standard";
    const name = typeof c.toolCallId === "string" ? nameById.get(c.toolCallId) : undefined;
    if (!name || !MECHANICAL_TOOLS.has(name)) return "standard";
  }
  return "mechanical";
}

/**
 * Effort actually placed on the outgoing request for this step. Standard
 * steps pass the session effort through untouched (including undefined —
 * each wire path applies its own default). Mechanical steps get
 * min(sessionEffort, ceiling) — never an up-shift: a session already below
 * the ceiling stays where it is. `ceiling` is the adapter's own floor
 * (default "low"; codex passes "medium" — its endpoint empties at "low").
 */
export function resolveStepReasoningEffort(
  stepEffortHint: TurnInput["stepEffortHint"],
  sessionEffort: ReasoningEffort | undefined,
  ceiling: ReasoningEffort = MECHANICAL_EFFORT_CEILING,
): ReasoningEffort | undefined {
  return stepEffortHint === "mechanical"
    ? capEffort(sessionEffort ?? DEFAULT_REASONING_EFFORT, ceiling)
    : sessionEffort;
}

// Assistant rows finalize tool calls as `content.toolCalls:
// [{ id, name, arguments }]` (openai-compat.ts / codex.ts message_finalized;
// canonical-to-chat-param.ts:47-50 parses the identical shape).
function toolNamesById(content: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!content || typeof content !== "object") return out;
  const tc = (content as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(tc)) return out;
  for (const t of tc) {
    if (t && typeof t === "object"
      && typeof (t as { id?: unknown }).id === "string"
      && typeof (t as { name?: unknown }).name === "string") {
      out.set((t as { id: string }).id, (t as { name: string }).name);
    }
  }
  return out;
}

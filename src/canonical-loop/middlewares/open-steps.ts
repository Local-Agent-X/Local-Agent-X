/**
 * Open-steps completion gate — when the model declared a multi-step plan via
 * the task tools and tries to end a turn with steps still pending/in_progress,
 * force one more turn pointed at the remaining work.
 *
 * This is the model-agnostic equalizer: strong models finish a declared plan on
 * their own; weaker ones (the early-stop case this guards) hand over a partial
 * and wait to be told "continue". The signal is OBJECTIVE — open tasks the model
 * itself created — which is what lets this run on INTERACTIVE turns too, unlike
 * the worker-only premature-completion gate (whose tool-less/no-commit signal
 * isn't safe for chat). A normal chat answer with no task list never trips it.
 *
 * Inert by design when no tasks exist, so it only bites on work the model
 * explicitly broke into steps. The system prompt directs task_create for
 * non-trivial multi-step work so the gate has teeth on the models that need it.
 */
import type { CanonicalMiddleware, CanonicalLoopContext, CanonicalMiddlewareResult } from "./types.js";
import type { Op } from "../../ops/types.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { getOpenTasksForSession } from "../../tools/task-tools.js";
import { readOpTurns } from "../store.js";
import { getMiddlewareState } from "./state.js";
import { EDIT_TOOLS } from "../../agent-guards/verify-gate.js";
import { opForbidsCapability } from "../instruction-ledger/index.js";

/**
 * Last open-task set we already nudged about, per session. Keyed by SESSION
 * (not op) on purpose: a task left open by mistake should be pushed at most once
 * per distinct open set across the whole conversation, not re-nagged on every
 * user message. When the model makes progress the set shrinks → new signature →
 * we push again; when it stops on the *same* set, we've already said our piece,
 * so we let the turn end rather than spin to the per-op turn cap. One short
 * string per session — negligible, not worth wiring an op-terminal sweep.
 */
const lastNudgedSignature = new Map<string, string>();

export const openStepsMiddleware: CanonicalMiddleware = {
  name: "open-steps",

  // Both hooks push plan-and-KEEP-WORKING — never against an explicit user
  // prohibition on changing the workspace ("read-only", "don't edit anything").
  // Fail-open: an op with no ledger entry is never suppressed.
  when: (ctx) => !opForbidsCapability(ctx.op.id, "workspace-write"),

  /**
   * Turn-0 plan seed. Worker runs are unattended, so a model that skips
   * planning gives up silently with nobody watching — seed the instruction
   * in-conversation, where weak models actually comply, instead of relying
   * on the system-prompt directive they ignore. Conditional phrasing keeps
   * single-action ops from manufacturing one-step task lists. The build lane
   * is excluded: auto-build has its own phase plan, and a second
   * planning directive there would fork the source of truth.
   */
  beforeTurn(ctx) {
    if (ctx.turnIdx !== 0) return { kind: "continue" };
    if (ctx.op.lane !== "agent" && ctx.op.lane !== "background") return { kind: "continue" };
    if (!ctx.toolNames.has("task_create")) return { kind: "continue" };
    const sessionId = getSessionForOp(ctx.op.id);
    if (!sessionId || getOpenTasksForSession(sessionId).length > 0) return { kind: "continue" };
    return {
      kind: "nudge",
      reason: "open-steps-seed",
      message:
        "Before you start: if this task involves multiple distinct steps, lay them out " +
        "with task_create (one per step), mark each with task_update as you complete it, " +
        "and do not finish while any step is still open. If it's a single action, skip " +
        "the list and just do it.",
    };
  },

  afterModelCall(ctx) {
    // Only when the turn is about to end: an answer with no tool calls. A turn
    // that requested tools is still working — nothing to gate yet.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    const sessionId = getSessionForOp(ctx.op.id);
    if (!sessionId) return { kind: "continue" };

    const open = getOpenTasksForSession(sessionId);
    if (open.length === 0) return interactiveBuildPlanSeed(ctx);

    const signature = open.map((t) => t.id).sort().join(",");
    if (lastNudgedSignature.get(sessionId) === signature) return { kind: "continue" };
    lastNudgedSignature.set(sessionId, signature);

    const list = open.map((t, i) => `${i + 1}. ${t.description}`).join("\n");
    const message =
      `You're ending this turn with ${open.length} step${open.length === 1 ? "" : "s"} ` +
      `still open on your task list:\n\n${list}\n\n` +
      "Continue with the next incomplete step now — don't stop until every step is " +
      "done. If a step is already finished, mark it complete with task_update. If you " +
      "are genuinely blocked on one, state the specific blocker instead of stopping silently.";

    return { kind: "nudge", message, reason: "open-steps" };
  },
};

interface SeedFlag { fired: boolean }

/**
 * Reactive plan-seed for INTERACTIVE coding turns. The beforeTurn seed above
 * only fires on unattended lanes, so an interactive "build me X" gets no plan:
 * a weaker model writes a few files, says "here you go", and stops — the exact
 * early-stop this whole gate exists to prevent, on the one lane it was excluded
 * from. When such a turn ends after actually WRITING files (the objective build
 * signal — a pure chat answer or a one-line reply commits nothing, so it can't
 * trip this) with no plan on record, push ONE plan-and-verify nudge. Once a plan
 * exists, the afterModelCall keep-going nudge above drives the remaining steps
 * and the verify gates check the output — the same machinery the unattended
 * lanes already get, reached from the interactive side. Fire-once per op; the
 * per-op turn cap bounds the rest.
 *
 * Deliberately gentler than earnedDoneNudge, which is excluded from interactive
 * on purpose ("never loop a turn out from under the user"): this is a single
 * push the model can satisfy by confirming — with evidence — that it's done.
 */
function interactiveBuildPlanSeed(ctx: CanonicalLoopContext): CanonicalMiddlewareResult {
  if (ctx.op.lane !== "interactive") return { kind: "continue" };
  if (!ctx.toolNames.has("task_create")) return { kind: "continue" };
  const wroteFiles = [...ctx.committingToolsThisOp].some((t) => EDIT_TOOLS.has(t));
  if (!wroteFiles) return { kind: "continue" };

  const flag = getMiddlewareState<SeedFlag>(ctx.op.id, "interactive-build-seed", () => ({ fired: false }));
  if (flag.fired) return { kind: "continue" };
  flag.fired = true;

  const message =
    "You've written or edited files toward this request but are ending the turn with no plan on record. " +
    "If a complete version of what was asked still needs work — remaining features, wiring, edge cases, or a " +
    "check that it actually runs — lay out the remaining steps with task_create (one per step), work through " +
    "them, and verify the result (build it / run it / open it) before you finish; don't stop while a step is open. " +
    "If the work is genuinely complete and you've confirmed it runs, say so and how you verified it. If it was a " +
    "single trivial change, just confirm it's done.";
  return { kind: "nudge", message, reason: "interactive-build-seed" };
}

/** True when THIS op successfully called a task_* tool — the precondition both
 *  the loud-partial warning and the earned-done gate share before they nag
 *  about open steps (so a later op that never touched the list isn't blamed for
 *  steps an earlier one left open). */
function opTouchedTaskLedger(opId: string): boolean {
  return readOpTurns(opId).some((turn) =>
    (turn.toolCallSummary ?? []).some((s) => s.resultStatus === "ok" && s.tool.startsWith("task_")),
  );
}

/**
 * Loud-partial warning for a turn that is genuinely terminating with steps
 * still open (the give-up moment after the nudge above was spent). Returns
 * null unless THIS op successfully called a task tool — a later chat turn
 * that never touched the list ("thanks!") must not be nagged about steps an
 * earlier op left open.
 *
 * Kept terse (<200 chars) so it reads as a status line, not a wall of text.
 * It no longer needs to dodge extractAgentOutput (server-utils.ts) — that now
 * selects the longest assistant message of the turn, so a short trailing
 * warning can't displace the real report regardless of length.
 */
export function openStepsTerminationWarning(opId: string): string | null {
  // Called from decide-outcome, not through the phase — so the `when` predicate
  // above doesn't cover it. Same suppression: never nag about unworked steps
  // when the user forbade doing the work.
  if (opForbidsCapability(opId, "workspace-write")) return null;
  const sessionId = getSessionForOp(opId);
  if (!sessionId) return null;
  const open = getOpenTasksForSession(sessionId);
  if (open.length === 0) return null;
  if (!opTouchedTaskLedger(opId)) return null;
  const names = open.map((t) => t.description).join("; ");
  const headline = `⚠️ Stopped with ${open.length} step${open.length === 1 ? "" : "s"} still open: `;
  const budget = 199 - headline.length;
  return headline + (names.length > budget ? names.slice(0, budget - 1) + "…" : names);
}

/**
 * Earned-"done" gate for UNATTENDED lanes (worker / background / build — never
 * interactive chat). When such an op declares it's done but its own task list
 * still has open steps, force exactly ONE more turn pointed at "finish or
 * justify stopping". The afterModelCall nudge above fires at most once per open
 * SET and is shared with interactive turns; this is the stricter terminal-time
 * gate that converts a soft "done" into a hard one-shot retry for runs nobody is
 * watching — the cross-model lever, since weaker models hand over partials and
 * wait to be told "continue" that never comes in an unattended run.
 *
 * Returns the nudge to inject (and records the fire), or null when the gate must
 * not bite: interactive lane, already fired once for this op, no open steps, or
 * this op never worked the task list (mirrors openStepsTerminationWarning so a
 * later op isn't force-looped over steps an earlier one left open). Bounded to
 * one fire per op; cleared on op terminal via clearEarnedDoneStateForOp.
 */
const earnedDoneFired = new Set<string>();

export function earnedDoneNudge(op: Op): string | null {
  // Called from decide-outcome, not through the phase — so the `when` predicate
  // above doesn't cover it. Same suppression as the hooks: never force another
  // work turn when the user forbade doing the work.
  if (opForbidsCapability(op.id, "workspace-write")) return null;
  if (op.lane === "interactive") return null;
  if (earnedDoneFired.has(op.id)) return null;
  const sessionId = getSessionForOp(op.id);
  if (!sessionId) return null;
  const open = getOpenTasksForSession(sessionId);
  if (open.length === 0) return null;
  if (!opTouchedTaskLedger(op.id)) return null;

  earnedDoneFired.add(op.id);
  const list = open.map((t, i) => `${i + 1}. ${t.description}`).join("\n");
  return (
    `You're ending this run with ${open.length} step${open.length === 1 ? "" : "s"} still open on ` +
    `your task list:\n\n${list}\n\n` +
    "This is an unattended run — no one will tell you to continue. Either finish the remaining " +
    "step(s) now (mark each done with task_update as you go), or, if you are genuinely blocked or a " +
    "step is no longer needed, state the specific reason before you stop. Do not stop silently."
  );
}

export function clearEarnedDoneStateForOp(opId: string): void {
  earnedDoneFired.delete(opId);
}

/** Test-only — drop the per-op earned-done fire record. */
export function _resetEarnedDoneState(): void {
  earnedDoneFired.clear();
}

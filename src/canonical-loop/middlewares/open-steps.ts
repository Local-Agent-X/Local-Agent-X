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
import type { CanonicalMiddleware } from "./types.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { getOpenTasksForSession } from "../../tools/task-tools.js";

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

  afterModelCall(ctx) {
    // Only when the turn is about to end: an answer with no tool calls. A turn
    // that requested tools is still working — nothing to gate yet.
    if (ctx.toolCalls.length > 0) return { kind: "continue" };
    if (ctx.assistantContent.trim().length === 0) return { kind: "continue" };

    const sessionId = getSessionForOp(ctx.op.id);
    if (!sessionId) return { kind: "continue" };

    const open = getOpenTasksForSession(sessionId);
    if (open.length === 0) return { kind: "continue" };

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

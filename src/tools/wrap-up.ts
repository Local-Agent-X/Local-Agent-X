/**
 * wrap_up — the agent's close of a turn that did work: its closing answer (what changed,
 * how it was checked, what is not done or not verified) and, when the next move is the
 * user's, one short question with one or two answer buttons. The chat draws the recap as
 * the reply's last paragraph and the question below it, on the desktop and the phone,
 * from the tool result's `metadata.wrapUp` (live and from history, like show_card's
 * card). A button only sends its words as the user's next message.
 *
 * The recap IS the closing answer, not a box beside one. Asked for both, the model wrote
 * only the box: across the 2026-11-17 parity battery a code reply's last prose was a
 * mid-task line ("Edits are in. Now the type-check."), and the result lived in a recap
 * capped at 400 characters. Claude Code's closing answer averaged about 1,340.
 *
 * A succeeded call ends the turn (its row's `closesTurn`, turn-loop/silent-tool-check.ts):
 * it goes out in the same response as the final answer, not as a step of its own.
 *
 * It also completes the step in progress on the session's step list (task-tools.ts):
 * the turn is over. Two cases keep the list honest:
 *
 *  - Steps of this request still pending, and no question. The open-steps gate
 *    reads a turn that ends in prose, and a turn that ends here never reaches
 *    it, so the close itself is refused, once per set of open steps, naming
 *    them: the agent carries on, or closes again saying what stops it. A call
 *    with an `ask` is not refused: it ends the turn on the question
 *    (turn-loop/ask-user-terminal.ts, through the row's `asksUser`) and the
 *    pending steps wait for the answer.
 *  - Background work this chat started is still running. Nothing is refused:
 *    waiting for it is the right way to end the turn. And the step that was in
 *    progress when the work was handed off is that work, so it stays in
 *    progress, not ticked. A chat that handed "install the APK" to a worker
 *    closed its turn, and the list showed the install done with nothing
 *    installed (Label Check Sol, 2026-11-26).
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { operationIdOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { opForbidsCapability, planModeForbidsCapability } from "../canonical-loop/public/plan-ledger.js";
import { isInteractiveHostOpType, readOp } from "../ops/op-store.js";
import { listOpsForSession } from "../ops/session-bridge.js";
import {
  finishCurrentStep, getOpenTasksForSession, markOpenSetPushed, openSetAlreadyPushed, pendingStepsWorkedSince,
} from "./task-tools.js";

/** The recap as the clients draw it (metadata.wrapUp; agentxos progress.ts). */
export interface WrapUp {
  recap: string;
  ask?: string;
  actions?: string[];
}

/** Room for a closing answer, not an essay. */
export const RECAP_MAX_CHARS = 1500;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The recap the arguments describe; null without one. Buttons need a question. */
export function wrapUpOf(args: Record<string, unknown>): WrapUp | null {
  const recap = text(args.recap, RECAP_MAX_CHARS);
  if (!recap) return null;
  const wrap: WrapUp = { recap };
  const ask = text(args.ask, 120);
  if (!ask) return wrap;
  wrap.ask = ask;
  const actions = (Array.isArray(args.actions) ? args.actions : []).map((a) => text(a, 30)).filter(Boolean).slice(0, 2);
  if (actions.length > 0) wrap.actions = actions;
  return wrap;
}

/** When each piece of background work this chat started and has not seen end
 *  was submitted: every live op bound to the session but the host turns (the
 *  one making this call among them). */
function liveBackgroundWork(sessionId: string): string[] {
  return listOpsForSession(sessionId)
    .map((id) => readOp(id))
    .filter((op): op is NonNullable<typeof op> => !!op && (op.status === "running" || op.status === "pending") && !isInteractiveHostOpType(op.type))
    .map((op) => op.createdAt);
}

/**
 * The refusal for a close that leaves this request's own steps unstarted, or
 * null when the close stands: the steps are an earlier request's, the agent
 * was already told about exactly this set, or the user forbade the work (a
 * push toward a call the pre-dispatch gate will deny only burns a turn).
 */
function openStepsRefusal(sessionId: string, opId: string | undefined): string | null {
  const op = opId ? readOp(opId) : null;
  if (!op) return null;
  if (opForbidsCapability(op.id, "workspace-write") || planModeForbidsCapability(sessionId, "workspace-write")) return null;
  const pending = pendingStepsWorkedSince(sessionId, op.startedAt ?? op.createdAt);
  if (pending.length === 0) return null;
  const open = getOpenTasksForSession(sessionId);
  if (openSetAlreadyPushed(sessionId, open)) return null;
  markOpenSetPushed(sessionId, open);
  const list = pending.map((t, i) => `${i + 1}. ${t.description}`).join("\n");
  return (
    `Not closed: ${pending.length} step${pending.length === 1 ? "" : "s"} of your plan ${pending.length === 1 ? "has" : "have"} not been started:\n\n${list}\n\n` +
    "wrap_up ends a turn whose work is done. Carry on with the next open step now. If a step is already finished, " +
    "mark it with update_plan. If a step is blocked, or is the user's to do, call wrap_up again and say so in the recap " +
    "(or put the decision in `ask`): that call will close the turn."
  );
}

export const wrapUpTool: ToolDefinition = {
  name: "wrap_up",
  compactDescription: "End a turn that did work: `recap` is your closing answer; optionally one question with 1-2 answer buttons.",
  description:
    "End a turn in which you changed files, ran commands or did multi-step work. `recap` is your closing answer, shown as the " +
    "last paragraph of your reply: what you changed, how you checked it, and what is not done or not verified, in a few plain " +
    "sentences (markdown is fine). Write no other closing text: the recap is the answer. Only when the next move is the user's " +
    "(a choice, a go-ahead, an approval), add one short question in `ask` with one or two short answer buttons in `actions` " +
    "(1-3 words each, your recommendation first); a button sends its words as the user's reply. Call it once: the turn ends " +
    "when it succeeds. With steps of your plan still not started and no question, it is refused once: do them, or say in the " +
    "recap what stops you. Skip it for a short answer or plain conversation.",
  parameters: {
    type: "object",
    properties: {
      recap: { type: "string", description: "Your closing answer: what you changed, how you checked it, what is not done or not verified." },
      ask: { type: "string", description: "One short question, only when the user must decide or approve something." },
      actions: { type: "array", items: { type: "string" }, description: "One or two short answers to `ask`, recommendation first." },
    },
    required: ["recap"],
  },
  async execute(args): Promise<ToolResult> {
    const wrapUp = wrapUpOf(args);
    if (wrapUp === null) return { content: "wrap_up needs a recap.", isError: true };
    const sessionId = (sessionIdOf(args) ?? "").trim();
    const liveWork = sessionId ? liveBackgroundWork(sessionId) : [];
    if (sessionId && !wrapUp.ask && liveWork.length === 0) {
      const refusal = openStepsRefusal(sessionId, operationIdOf(args));
      if (refusal) return { content: refusal, isError: true };
    }
    const op = operationIdOf(args) ? readOp(operationIdOf(args)!) : null;
    const plan = finishCurrentStep(sessionId, liveWork, op ? op.startedAt ?? op.createdAt : undefined);
    const said = wrapUp.ask ? " The question is shown with its buttons: end your turn here and wait for the answer." : "";
    return { content: `Shown to the user as the turn's recap.${said}`, metadata: { wrapUp, ...(plan.length > 0 ? { plan } : {}) } };
  },
};

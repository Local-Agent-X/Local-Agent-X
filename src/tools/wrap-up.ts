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
 * the turn is over. A step still pending stays open, so the open-steps gate still
 * sees declared work left undone — unless the call asked: a succeeded call with an
 * `ask` ends the turn on the question (turn-loop/ask-user-terminal.ts, through the
 * row's `asksUser`), so the pending steps wait for the answer instead of a nudge.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { finishCurrentStep } from "./task-tools.js";

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

export const wrapUpTool: ToolDefinition = {
  name: "wrap_up",
  compactDescription: "End a turn that did work: `recap` is your closing answer; optionally one question with 1-2 answer buttons.",
  description:
    "End a turn in which you changed files, ran commands or did multi-step work. `recap` is your closing answer, shown as the " +
    "last paragraph of your reply: what you changed, how you checked it, and what is not done or not verified, in a few plain " +
    "sentences (markdown is fine). Write no other closing text: the recap is the answer. Only when the next move is the user's " +
    "(a choice, a go-ahead, an approval), add one short question in `ask` with one or two short answer buttons in `actions` " +
    "(1-3 words each, your recommendation first); a button sends its words as the user's reply. Call it once: the turn ends " +
    "when it succeeds. Skip it for a short answer or plain conversation.",
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
    const plan = finishCurrentStep((sessionIdOf(args) ?? "").trim());
    const said = wrapUp.ask ? " The question is shown with its buttons: end your turn here and wait for the answer." : "";
    return { content: `Shown to the user as the turn's recap.${said}`, metadata: { wrapUp, ...(plan.length > 0 ? { plan } : {}) } };
  },
};

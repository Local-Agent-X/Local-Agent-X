/**
 * wrap_up — the agent's close of a turn that did work: a two-or-three-sentence recap
 * of what is now true and what is not done or not verified, and, when the next move is
 * the user's, one short question with one or two answer buttons. The chat draws it as a
 * box at the end of the reply, on the desktop and the phone, from the tool result's
 * `metadata.wrapUp` (live and from history, like show_card's card). A button only
 * sends its words as the user's next message.
 *
 * It also completes the step in progress on the session's step list (task-tools.ts):
 * the turn is over. A step still pending stays open, so the open-steps gate still
 * sees declared work left undone.
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

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The recap the arguments describe; null without one. Buttons need a question. */
export function wrapUpOf(args: Record<string, unknown>): WrapUp | null {
  const recap = text(args.recap, 400);
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
  compactDescription: "End a turn that did work: a 2-3 sentence recap the user sees as a box, and optionally one question with 1-2 answer buttons.",
  description:
    "End a turn in which you changed files, ran commands or did multi-step work: the chat shows a box at the end of your reply " +
    "with `recap` (two or three short sentences: what is now true, then what is not done or not verified) and, only when the next " +
    "move is the user's (a choice, a go-ahead, an approval), one short question in `ask` with one or two short answer buttons in " +
    "`actions` (1-3 words each, your recommendation first). A button sends its words as the user's reply. Call it last, once, " +
    "and don't repeat the recap in your text. Skip it for a short answer or plain conversation.",
  parameters: {
    type: "object",
    properties: {
      recap: { type: "string", description: "Two or three short sentences: what is now true, and what is not done or not verified." },
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

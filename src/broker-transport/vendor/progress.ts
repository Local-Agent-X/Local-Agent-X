// What the agent shows about a turn's progress (LAX src/tools/task-tools.ts and
// src/tools/wrap-up.ts), drawn under the reply on the desktop and the phone alike:
//   - its step list: every task tool's result carries the session's whole list as
//     `metadata.plan`, so the newest one in a turn is the list;
//   - its recap: wrap_up's `metadata.wrapUp`, two or three sentences and, when the
//     next move is the user's, one question with answer buttons that only send their
//     words as the user's next message.
// Both ride the tool result's metadata, on the live `tool_end` and on the tool events
// of a reloaded history.

import { asRecord, asString } from "./guards.js";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed";
export type PlanStep = { text: string; status: PlanStepStatus };

export type WrapUp = {
  recap: string;
  /** One question, when the user must decide. */
  ask?: string;
  /** Answers to `ask`, the agent's recommendation first. */
  actions?: string[];
};

const STATUSES: readonly string[] = ["pending", "in_progress", "completed", "failed"];

/** The step list in a tool result's metadata, or null when it carries none. A step
 *  without text is left out; an unknown status reads as pending. */
export function parsePlanMetadata(metadata: unknown): PlanStep[] | null {
  const plan = asRecord(metadata)?.plan;
  if (!Array.isArray(plan)) return null;
  const steps = plan.flatMap((raw) => {
    const o = asRecord(raw);
    const text = asString(o?.text);
    if (!text) return [];
    const status = asString(o?.status);
    return [{ text, status: (status !== null && STATUSES.includes(status) ? status : "pending") as PlanStepStatus }];
  });
  return steps.length > 0 ? steps : null;
}

/** The recap in a tool result's metadata, or null when it carries none. Answer
 *  buttons need a question. */
export function parseWrapUpMetadata(metadata: unknown): WrapUp | null {
  const w = asRecord(asRecord(metadata)?.wrapUp);
  const recap = asString(w?.recap);
  if (w === null || !recap) return null;
  const wrap: WrapUp = { recap };
  const ask = asString(w.ask);
  if (!ask) return wrap;
  wrap.ask = ask;
  const actions = (Array.isArray(w.actions) ? w.actions : []).flatMap((a) => {
    const s = asString(a);
    return s ? [s] : [];
  });
  if (actions.length > 0) wrap.actions = actions;
  return wrap;
}

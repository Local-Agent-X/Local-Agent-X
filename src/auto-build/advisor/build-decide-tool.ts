/**
 * build_decide — the build lead's answer to a decision the engine is waiting
 * on (lead-decisions.ts). The lead's chat is told each decision's id and the
 * evidence; this call is the only way its answer reaches the engine.
 */
import type { ToolDefinition, ToolResult } from "../../types.js";
import { LEAD_ACTIONS, resolveLeadDecision, type LeadAction, type LeadDecision } from "./lead-decisions.js";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The decision the arguments describe, or what is missing from them. */
export function readDecision(args: Record<string, unknown>): LeadDecision | { error: string } {
  const action = text(args.action) as LeadAction;
  if (!LEAD_ACTIONS.includes(action)) return { error: `action must be one of: ${LEAD_ACTIONS.join(", ")}.` };
  const reasoning = text(args.reasoning);
  if (!reasoning) return { error: "Say why in `reasoning`: it is shown where the build reports from." };
  const instruction = text(args.instruction);
  const followUps = Array.isArray(args.follow_ups) ? args.follow_ups.map(text).filter(Boolean) : [];
  const doneWhen = text(args.done_when);
  const question = text(args.question);
  if ((action === "continue" || action === "fresh") && !instruction) return { error: `"${action}" needs \`instruction\`: what the worker must do.` };
  if (action === "narrow" && !doneWhen) return { error: `"narrow" needs \`done_when\`: the chunk's contract as it now stands.` };
  if (action === "park" && !question) return { error: `"park" needs \`question\`: what only the owner can decide.` };
  return {
    action, reasoning,
    ...(instruction ? { instruction } : {}),
    ...(followUps.length ? { followUps } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(question ? { question } : {}),
  };
}

export const buildDecideTool: ToolDefinition = {
  name: "build_decide",
  compactDescription: "Answer a build decision the engine is waiting on (build lead only).",
  description:
    "Answer a decision the build engine is waiting on, as the build's lead. The decision's id and its evidence " +
    "are in the message that asked. continue: the worker fixes what you say. fresh: a new worker, with what you " +
    "say. accept: the chunk lands; what is left goes on record as follow-ups. narrow: the chunk's done-when " +
    "becomes yours. park: the build stops on a question only the owner can answer.",
  parameters: {
    type: "object",
    properties: {
      decision_id: { type: "string", description: "The id from the message that asked." },
      action: { type: "string", enum: [...LEAD_ACTIONS], description: "What the engine does next." },
      reasoning: { type: "string", description: "Why, in a sentence or two." },
      instruction: { type: "string", description: "continue / fresh: exactly what the worker must do." },
      follow_ups: { type: "array", items: { type: "string" }, description: "accept: what is left, one item each." },
      done_when: { type: "string", description: "narrow: the chunk's done-when as it now stands." },
      question: { type: "string", description: "park: the question for the owner." },
    },
    required: ["decision_id", "action", "reasoning"],
  },
  async execute(args): Promise<ToolResult> {
    const id = text(args.decision_id);
    const decision = readDecision(args);
    if ("error" in decision) return { content: decision.error, isError: true };
    if (!resolveLeadDecision(id, decision)) {
      return { content: `No build decision is waiting under "${id}": it was answered, timed out, or never asked.`, isError: true };
    }
    return { content: `Decision ${id}: ${decision.action}. The engine carries it out; end your turn.` };
  },
};

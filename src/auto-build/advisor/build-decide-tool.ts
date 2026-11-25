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
  const owedCheck = text(args.owed_check);
  const evidence = text(args.evidence);
  const report = text(args.report);
  const parts = Array.isArray(args.parts)
    ? args.parts.map((p) => ({ title: text((p as Record<string, unknown>)?.title), doneWhen: text((p as Record<string, unknown>)?.done_when) }))
    : [];
  if ((action === "continue" || action === "fresh") && !instruction) return { error: `"${action}" needs \`instruction\`: what the worker must do.` };
  if (action === "narrow" && !doneWhen) return { error: `"narrow" needs \`done_when\`: the chunk's contract as it now stands.` };
  if (action === "split" && (!doneWhen || parts.length < 1 || parts.length > 3 || parts.some((p) => !p.title || !p.doneWhen))) {
    return { error: `"split" needs \`done_when\` (what this chunk keeps) and \`parts\`: one to three of { title, done_when }, each a new chunk.` };
  }
  if (action === "park" && !question) return { error: `"park" needs \`question\`: what only the owner can decide.` };
  if (action === "owed" && !owedCheck) return { error: `"owed" needs \`owed_check\`: the check only the owner can run, and what it needs.` };
  if (action === "overrule" && !evidence) return { error: `"overrule" needs \`evidence\`: what shows the check's finding is wrong (output, file:line).` };
  return {
    action, reasoning,
    ...(instruction ? { instruction } : {}),
    ...(followUps.length ? { followUps } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(action === "split" ? { parts } : {}),
    ...(question ? { question } : {}),
    ...(owedCheck ? { owedCheck } : {}),
    ...(evidence ? { evidence } : {}),
    ...(report ? { report } : {}),
  };
}

export const buildDecideTool: ToolDefinition = {
  name: "build_decide",
  compactDescription: "Answer a build decision the engine is waiting on (build lead only).",
  description:
    "Answer a decision the build engine is waiting on, as the build's lead. The decision's id and its evidence " +
    "are in the message that asked. continue: the worker fixes what you say. fresh: a new worker, with what you " +
    "say. accept: the chunk lands; what is left goes on record as follow-ups. narrow: the chunk's done-when " +
    "becomes yours. split: the chunk keeps the done-when you give, and each of `parts` becomes a new chunk. owed: the chunk lands unverified with a check only the owner can run, asked at the end. " +
    "overrule: a check's finding is wrong, shown by your evidence; the chunk lands and the check is recorded. " +
    "park: the chunk is set aside on a question only the owner can answer. Other decisions list what each " +
    "answer does in the message that asked.",
  parameters: {
    type: "object",
    properties: {
      decision_id: { type: "string", description: "The id from the message that asked." },
      action: { type: "string", enum: [...LEAD_ACTIONS], description: "What the engine does next." },
      reasoning: { type: "string", description: "Why, in a sentence or two." },
      instruction: { type: "string", description: "continue / fresh: exactly what the worker must do." },
      follow_ups: { type: "array", items: { type: "string" }, description: "accept / owed / overrule: what is left, one item each." },
      done_when: { type: "string", description: "narrow / split: the chunk's done-when as it now stands." },
      parts: {
        type: "array", description: "split: what moves out of the chunk, one to three new chunks built after the plan's.",
        items: { type: "object", properties: { title: { type: "string" }, done_when: { type: "string" } }, required: ["title", "done_when"] },
      },
      question: { type: "string", description: "park: the question for the owner." },
      owed_check: { type: "string", description: "owed: the check only the owner can run, and what it needs." },
      evidence: { type: "string", description: "overrule: what shows the finding is wrong (output, file:line)." },
      report: { type: "string", description: "The end of a build run: your ledger entry for it." },
    },
    required: ["decision_id", "action", "reasoning"],
  },
  async execute(args): Promise<ToolResult> {
    const id = text(args.decision_id);
    const decision = readDecision(args);
    if ("error" in decision) return { content: decision.error, isError: true };
    const refused = resolveLeadDecision(id, decision);
    if (refused) return { content: refused, isError: true };
    return { content: `Decision ${id}: ${decision.action}. The engine carries it out; end your turn.` };
  },
};

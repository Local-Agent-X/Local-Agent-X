/**
 * build_next: how a build's lead drives the build from its own turn.
 *
 * The call waits until the build has something for the lead (a batch that
 * landed, a decision that is waiting, the build's end) and returns it, so the
 * lead reads each result where it can act on it and calls again. The wait,
 * and what ends it, is advisor/lead-channel.ts.
 */
import type { ToolDefinition, ToolResult } from "../../types.js";
import { sessionIdOf, onProgressOf } from "../../tool-execution/internal-args.js";
import { hasInjects } from "../../agent-loop/inject-queue.js";
import { takeForLead, type LeadItem, type LeadWaitEnd } from "../advisor/lead-channel.js";
import { listActive } from "./manager.js";

/** What to call next, by what the build handed over. */
function nextStep(items: LeadItem[]): string {
  if (items.some((i) => i.kind === "decision")) return "Answer each decision with build_decide, then call build_next again.";
  if (items.some((i) => i.kind === "ended")) return "";
  return "The build waits here for you. Look into anything you doubt, then call build_next to go on.";
}

const ENDED_EMPTY: Record<Exclude<LeadWaitEnd, "items">, string> = {
  "user-message": "The user sent a message. Answer it, then call build_next again to go on leading the build; the build keeps running meanwhile.",
  stopped: "Stopped waiting. The build itself is still running; its card has Pause and Cancel.",
  "not-running": "No build this chat leads is running. build_plan_status shows where each build stands, and build_plan_resume goes on with one that halted.",
};

/** build_next's result for what the wait ended with. */
export function buildNextResult(why: LeadWaitEnd, items: LeadItem[]): string {
  if (why !== "items") return ENDED_EMPTY[why];
  return [...items.map((i) => i.text), nextStep(items)].filter(Boolean).join("\n\n---\n\n");
}

export const buildNextTool: ToolDefinition = {
  name: "build_next",
  compactDescription: "Wait for the running build's next result or decision (build lead only).",
  description:
    "Lead a running build from this turn. The call waits until the build has something for you and returns it: " +
    "the chunks of a batch that landed, with each one's report and review; a decision that is waiting, with its " +
    "evidence; or the build's end. Read it, answer any decision with build_decide, and call build_next again. " +
    "While you lead this way the build stops after each batch until you call again, so you can check the work " +
    "first. Call it right after run_build_plan or build_plan_resume. It returns early when the user writes.",
  parameters: { type: "object", properties: {} },
  async execute(args, signal): Promise<ToolResult> {
    const sessionId = sessionIdOf(args);
    if (!sessionId) return { content: "build_next is for the chat that started a build.", isError: true };
    const { why, items } = await takeForLead(sessionId, {
      signal,
      onProgress: onProgressOf(args),
      stillRunning: () => listActive().some((o) => o.sessionId === sessionId),
      userIsWaiting: () => hasInjects(sessionId),
    });
    return { content: buildNextResult(why, items), metadata: { ended: why, items: items.map((i) => i.kind) } };
  },
};

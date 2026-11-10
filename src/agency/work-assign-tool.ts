/**
 * `work_assign` — the orchestrator hands a task to a chat that is already
 * working in its project (ADR 0007 §7). A new piece of work goes to a worker
 * (`agent_spawn`); this is for the chat that already has the context.
 *
 * Only the project's orchestrator may call it, and only for a chat known in
 * that project (one holding claims there): it cannot reach an arbitrary
 * conversation. A chat in the middle of a turn gets the task as a message into
 * that turn (the inject queue); an idle one runs a turn for it
 * (session/assigned-turn.ts), and the orchestrator hears when it settles.
 */
import type { ToolDefinition, ToolResult } from "../types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { rolesOf } from "./orchestrator-role.js";
import { holdersOfSession, liveHolders, type HolderView } from "./work-claims.js";

export const ASSIGN_TASK_MAX = 4_000;

function err(content: string): ToolResult { return { content, isError: true }; }

/** The chats of the caller's projects it may hand work to. */
export function assignableChats(callerSessionId: string): HolderView[] {
  const repos = new Set(rolesOf(callerSessionId).map((r) => r.repoKey));
  return liveHolders().filter((h) => repos.has(h.repoKey) && h.kind === "chat" && h.sessionId !== callerSessionId);
}

/** The one chat `named` means, by its id or its name; an error saying which exist otherwise. */
export function pickChat(chats: HolderView[], named: string): HolderView | { error: string } {
  const want = named.trim().toLowerCase();
  const byId = chats.filter((h) => h.sessionId.toLowerCase() === want);
  const hits = byId.length ? byId : chats.filter((h) => h.displayName.trim().toLowerCase() === want);
  const unique = [...new Map(hits.map((h) => [h.sessionId, h])).values()];
  if (unique.length === 1) return unique[0];
  const known = [...new Map(chats.map((h) => [h.sessionId, h])).values()].map((h) => `"${h.displayName}" (${h.sessionId})`);
  if (unique.length > 1) return { error: `More than one chat is called "${named}". Use its id: ${known.join(", ")}.` };
  return { error: known.length ? `No chat called "${named}" is working in this project. The chats here: ${known.join(", ")}.` : "No other chat is working in this project. Start a worker with agent_spawn instead." };
}

export const workAssignTool: ToolDefinition = {
  name: "work_assign",
  description:
    "Orchestrator only: hand a task to a chat that is already working in this project, by its name or id. "
    + "It runs the task as its next turn (or takes it into the turn it is running) and you hear when it settles. "
    + "For a new piece of work, start a worker with agent_spawn instead.",
  parameters: {
    type: "object",
    properties: {
      chat: { type: "string", description: "The chat's name as your project list shows it, or its id." },
      task: { type: "string", description: `What it should do, complete enough to act on: it does not see this conversation. At most ${ASSIGN_TASK_MAX} characters.` },
    },
    required: ["chat", "task"],
  },
  async execute(args) {
    const sessionId = sessionIdOf(args);
    if (!sessionId) return err("work_assign needs a session.");
    const roles = rolesOf(sessionId);
    if (roles.length === 0) return err("Only the project's orchestrator hands tasks to other chats. The user makes a chat the orchestrator from the strip above it.");
    const task = typeof args.task === "string" ? args.task.trim().slice(0, ASSIGN_TASK_MAX) : "";
    if (!task) return err("task is required.");
    const picked = pickChat(assignableChats(sessionId), String(args.chat ?? ""));
    if ("error" in picked) return err(picked.error);
    const originName = holdersOfSession(sessionId)[0]?.displayName ?? "the orchestrator chat";
    // Loaded here, not at the top: it reaches the turn loop, which loads the tools.
    const { deliverAssignedTask } = await import("../session/assigned-turn.js");
    const how = deliverAssignedTask({ originId: sessionId, originName, targetId: picked.sessionId, targetName: picked.displayName, repoKey: picked.repoKey, task });
    return {
      content: how === "started"
        ? `"${picked.displayName}" started on the task. You will hear when it settles; you do not need to wait or check.`
        : `"${picked.displayName}" is in the middle of a turn: the task was added to it and it will take it up next.`,
    };
  },
};

/**
 * A turn one chat gives another: the project's orchestrator handing a task to
 * a chat that is already working there (ADR 0007 §7, the `work_assign` tool).
 *
 * Like a chat started from another (linked-chat.ts), the turn runs through the
 * handler a typed message uses, so it streams to anyone viewing that chat and
 * passes every gate, and it is the assigning chat's child for trust: it takes
 * on that chat's taint and external-ingestion marks first, and what it reads
 * flows back when its turn settles. Without that, an orchestrator whose own
 * send was refused could have a clean chat send the same bytes.
 *
 * When it settles the assigning chat hears: its next turn's prompt carries the
 * outcome (ops/pending-notifications.ts), and the orchestrator is woken for it
 * (agency/orchestrator-wake.ts).
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { inheritSessionLineage, returnSessionLineage } from "../canonical-loop/index.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { raiseToOrchestrator } from "../agency/orchestrator-wake.js";
import { notesSince } from "../agency/handover-notes.js";
import { pushInject } from "../agent-loop/inject-queue.js";
import { hasActiveTurn } from "./turn-lock.js";
import { createLogger } from "../logger.js";

const logger = createLogger("session.assigned-turn");

export interface AssignedTurn {
  originId: string;
  originName: string;
  targetId: string;
  targetName: string;
  repoKey: string;
  task: string;
}

/** The message the chat receives: the task, saying who it is from. */
export function assignedMessage(a: Pick<AssignedTurn, "originName" | "task">): string {
  return `(From "${a.originName}", the orchestrator of this project: the user put it in charge of who works on what. This is not typed by the user.)\n\n${a.task}`;
}

/**
 * Deliver the task: into the turn the chat is running (the inject queue), or
 * as a turn of its own, which is not waited for. Either way the chat takes on
 * the assigning chat's lineage first.
 */
export function deliverAssignedTask(a: AssignedTurn): "added-to-running-turn" | "started" {
  if (hasActiveTurn(a.targetId)) {
    inheritSessionLineage(a.targetId, a.originId);
    pushInject(a.targetId, assignedMessage(a));
    return "added-to-running-turn";
  }
  void runAssignedTurn(a).catch((e) => logger.warn(`[assigned-turn] ${a.targetId}: ${(e as Error).message}`));
  return "started";
}

/** Run the turn, then tell the assigning chat how it went. */
export async function runAssignedTurn(a: AssignedTurn): Promise<void> {
  const startedAt = new Date().toISOString();
  let status: "completed" | "failed" = "completed";
  let summary = "";
  const handler = getChatHandler();
  if (!handler) {
    status = "failed";
    summary = "The chat could not take the task: the chat runner is not up yet.";
  } else {
    inheritSessionLineage(a.targetId, a.originId);
    try {
      await handler(a.targetId, assignedMessage(a), [], { channel: "web" });
    } catch (e) {
      logger.warn(`[assigned-turn] ${a.targetId} failed: ${(e as Error).message}`);
      status = "failed";
      summary = `It stopped with an error: ${(e as Error).message}`;
    }
    try {
      returnSessionLineage(a.targetId, a.originId);
    } catch (e) {
      logger.error(`[assigned-turn] lineage back to ${a.originId} failed: ${(e as Error).message}`);
    }
  }
  if (!summary) {
    const said = notesSince(a.repoKey, startedAt).filter((n) => n.sessionId === a.targetId).map((n) => n.text);
    summary = said.length ? said.join(" ") : "It finished its turn and left no hand-over note; its changes show under its name in the agents panel.";
  }
  pushPendingNotification(a.originId, {
    opId: `chat:${a.targetId}`, status, summary, filesChanged: [],
    task: `The task handed to "${a.targetName}"`, completedAt: Date.now(),
    linkedChat: { sessionId: a.targetId, title: a.targetName },
  });
  raiseToOrchestrator(a.repoKey, `assigned|${a.targetId}|${startedAt}`,
    `"${a.targetName}" ${status === "completed" ? "finished" : "could not finish"} the task you handed it.`);
}

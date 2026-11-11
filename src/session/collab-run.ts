/**
 * Running a collab (ADR 0007 §9, agency/collab.ts): each round, every member
 * chat runs one turn at the same time; when all have settled their answers go
 * on the collab's record, and the next round sends each member the others'.
 * After the last round the chat the collab started from runs a turn that
 * writes the result.
 *
 * Every turn goes through the handler a typed message uses
 * (chat-ws/chat-handler.ts), so it streams to anyone viewing that chat and
 * passes every gate. A member is the starting chat's child for trust, as a
 * chat started from another is (linked-chat.ts): it takes on that chat's taint
 * and external-ingestion marks before each turn, and what it read flows back
 * when the turn settles, before the starting chat reads its answer.
 *
 * A member whose turn fails or ends without a reply is dropped and named; the
 * collab goes on with the rest, and stops when nobody is left.
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { inheritSessionLineage, returnSessionLineage } from "../canonical-loop/index.js";
import { isHarnessRow } from "../harness-rows.js";
import { abortTurn, hasActiveTurn, onTurnRelease } from "./turn-lock.js";
import { createLogger } from "../logger.js";
import type { ServerContext } from "../server-context.js";
import type { Session } from "../types.js";
import {
  activeMembers, getCollab, resultMessage, roundMessage, updateCollab,
  COLLAB_ANSWER_MAX, type Collab, type CollabMember,
} from "../agency/collab.js";

const logger = createLogger("session.collab-run");

type Ctx = Pick<ServerContext, "sessionStore" | "flushSession">;

/** Told when a collab's record changes, so open tabs re-read it. */
let onChanged: (id: string) => void = () => {};
export function setCollabChangedListener(fn: (id: string) => void): void { onChanged = fn; }

function change(id: string, fn: (c: Collab) => void): Collab | null {
  const after = updateCollab(id, fn);
  try { onChanged(id); } catch { /* a listener never stops a collab */ }
  return after;
}

/** The chat's reply written after its first `from` messages, or null. */
export function replyAfter(session: Pick<Session, "messages"> | null, from: number): string | null {
  const rows = session?.messages ?? [];
  // A turn that compacted the chat leaves fewer rows than it started with.
  const added = rows.length >= from ? rows.slice(from) : rows;
  const reply = [...added].reverse()
    .find((m) => m.role === "assistant" && !isHarnessRow(m) && typeof m.content === "string" && m.content.trim());
  return reply ? String(reply.content).trim() : null;
}

/** One member's turn for `round`: its answer, or why there is none. */
async function memberTurn(ctx: Ctx, c: Collab, m: CollabMember, round: number): Promise<{ answer: string } | { failed: string }> {
  const handler = getChatHandler();
  if (!handler) return { failed: "the chat runner was not up" };
  const before = ctx.sessionStore.load(m.sessionId)?.messages.length ?? 0;
  inheritSessionLineage(m.sessionId, c.hostId);
  try {
    await handler(m.sessionId, roundMessage(c, m, round), [], { channel: "web" });
    await ctx.flushSession(m.sessionId);
  } catch (e) {
    logger.warn(`[collab ${c.id}] ${m.sessionId} failed: ${(e as Error).message}`);
    return { failed: "its turn stopped with an error" };
  } finally {
    try { returnSessionLineage(m.sessionId, c.hostId); } catch (e) {
      logger.error(`[collab ${c.id}] lineage back to ${c.hostId} failed: ${(e as Error).message}`);
    }
  }
  const answer = replyAfter(ctx.sessionStore.load(m.sessionId), before);
  return answer ? { answer: answer.slice(0, COLLAB_ANSWER_MAX) } : { failed: "it gave no answer" };
}

/** Run one round for every member still in; false when the collab is over. */
async function runRound(ctx: Ctx, id: string, round: number): Promise<boolean> {
  const c = change(id, (x) => { x.round = round; });
  if (!c || c.state !== "running") return false;
  const members = activeMembers(c);
  const settled = await Promise.all(members.map((m) => memberTurn(ctx, c, m, round)));
  const after = change(id, (x) => {
    members.forEach((m, i) => {
      const rec = x.members.find((y) => y.sessionId === m.sessionId);
      const got = settled[i];
      if (!rec) return;
      // A stopped collab's turns were cut off: nobody is dropped for that.
      if ("answer" in got) rec.answers.push(got.answer);
      else if (x.state === "running") rec.dropped = got.failed;
    });
    if (x.state === "running" && activeMembers(x).length === 0) {
      x.state = "stopped"; x.note = "No member gave an answer."; x.endedAt = new Date().toISOString();
    }
  });
  return !!after && after.state === "running";
}

function whenIdle(sessionId: string): Promise<void> {
  if (!hasActiveTurn(sessionId)) return Promise.resolve();
  return new Promise((resolve) => onTurnRelease(sessionId, resolve));
}

/** The starting chat's turn that writes the result. */
async function writeResult(ctx: Ctx, id: string): Promise<void> {
  const c = change(id, (x) => { if (x.state === "running") x.state = "writing"; });
  if (!c || c.state !== "writing") return;
  let note: string | undefined;
  const handler = getChatHandler();
  try {
    if (!handler) throw new Error("the chat runner was not up");
    await whenIdle(c.hostId);
    await handler(c.hostId, resultMessage(c), [], { channel: "web" });
    await ctx.flushSession(c.hostId);
  } catch (e) {
    logger.warn(`[collab ${id}] result turn failed: ${(e as Error).message}`);
    note = "The result could not be written; each member's answer is in its own chat.";
  }
  change(id, (x) => {
    if (x.state !== "writing") return;
    x.state = note ? "stopped" : "done";
    if (note) x.note = note;
    x.endedAt = new Date().toISOString();
  });
}

/** The collabs this process is running. A record still marked running that is
 *  not here was cut off by a restart. */
const live = new Set<string>();

/** Run a saved collab to its end. Never throws: what went wrong is on the record. */
export async function runCollab(ctx: Ctx, id: string): Promise<void> {
  live.add(id);
  try {
    const rounds = getCollab(id)?.rounds ?? 0;
    for (let round = 1; round <= rounds; round++) {
      if (!(await runRound(ctx, id, round))) return;
    }
    await writeResult(ctx, id);
  } catch (e) {
    logger.error(`[collab ${id}] stopped: ${(e as Error).message}`);
    change(id, (x) => {
      if (x.state === "done" || x.state === "stopped") return;
      x.state = "stopped"; x.note = "It stopped with an error."; x.endedAt = new Date().toISOString();
    });
  } finally {
    live.delete(id);
  }
}

/** Close the record of a collab a restart cut off. */
export function closeIfCutOff(c: Collab): Collab {
  if ((c.state !== "running" && c.state !== "writing") || live.has(c.id)) return c;
  return change(c.id, (x) => {
    x.state = "stopped"; x.note = "The app was restarted while it ran; each member's answers so far are in its own chat."; x.endedAt = new Date().toISOString();
  }) ?? c;
}

/** The user stopped it: no further round runs, and the turns in flight are cut off. */
export function stopCollab(id: string): Collab | null {
  const before = getCollab(id);
  if (!before || before.state === "done" || before.state === "stopped") return before;
  const after = change(id, (x) => { x.state = "stopped"; x.note = "Stopped by the user."; x.endedAt = new Date().toISOString(); });
  for (const m of before.members) abortTurn(m.sessionId);
  if (before.state === "writing") abortTurn(before.hostId);
  return after;
}

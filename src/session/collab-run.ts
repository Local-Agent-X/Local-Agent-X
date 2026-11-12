/**
 * Running a collab (ADR 0007 §9, agency/collab.ts). Each step is one turn in
 * every member chat that has something to do in it, all at the same time;
 * when they have settled, what each wrote for the app goes on the collab's
 * record (agency/collab-claims.ts) and the next step is built from it:
 *
 *   research → (a second ask for a report with no readable claims) →
 *   challenge → answer → up to two rounds on what is still disputed →
 *   the starting chat writes the result
 *
 * The starting chat runs no turn until the result: it takes no part in the
 * research. Its result must name every dispute still open; the app checks,
 * asks once for any it left out, and puts on the record what is still missing.
 *
 * Every turn goes through the handler a typed message uses
 * (chat-ws/chat-handler.ts), so it streams to anyone viewing that chat and
 * passes every gate. A member is the starting chat's child for trust, as a
 * chat started from another is (linked-chat.ts): it takes on that chat's taint
 * and external-ingestion marks before each turn, and what it read flows back
 * when the turn settles, before the starting chat reads its report.
 *
 * A member whose turn fails or ends without a reply is dropped and named; its
 * report so far still reaches the result. The collab stops when no member
 * gave a report at all.
 */
import { getChatHandler } from "../chat-ws/chat-handler.js";
import { inheritSessionLineage, returnSessionLineage } from "../canonical-loop/index.js";
import { isHarnessRow } from "../harness-rows.js";
import { abortTurn, hasActiveTurn, onTurnRelease } from "./turn-lock.js";
import { createLogger } from "../logger.js";
import type { ServerContext } from "../server-context.js";
import type { Session } from "../types.js";
import {
  activeMembers, clipReport, getCollab, updateCollab,
  COLLAB_DISPUTE_ROUNDS, COLLAB_REPORT_MAX, type Collab, type CollabMember, type CollabPhase,
} from "../agency/collab.js";
import { applyResponses, applyVerdicts, disputeSignature, disputesMissingFrom, openDisputes, parseClaims } from "../agency/collab-claims.js";
import {
  answerMessage, challengeMessage, claimsRepairMessage, disputeMessage, missingDisputesMessage, researchMessage, resultMessage,
} from "../agency/collab-messages.js";

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

function end(c: Collab, state: "done" | "stopped", note?: string): void {
  c.state = state;
  if (note) c.note = note;
  c.endedAt = new Date().toISOString();
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

/** One turn in `sessionId`: its reply, or why there is none. */
async function turn(ctx: Ctx, sessionId: string, message: string): Promise<{ reply: string } | { failed: string }> {
  const handler = getChatHandler();
  if (!handler) return { failed: "the chat runner was not up" };
  const before = ctx.sessionStore.load(sessionId)?.messages.length ?? 0;
  try {
    await handler(sessionId, message, [], { channel: "web" });
    await ctx.flushSession(sessionId);
  } catch (e) {
    logger.warn(`[collab] ${sessionId} failed: ${(e as Error).message}`);
    return { failed: "its turn stopped with an error" };
  }
  const reply = replyAfter(ctx.sessionStore.load(sessionId), before);
  return reply ? { reply } : { failed: "it gave no answer" };
}

/** A member's turn: it is the starting chat's child for trust around it. */
async function memberTurn(ctx: Ctx, c: Collab, m: CollabMember, message: string): Promise<{ reply: string } | { failed: string }> {
  inheritSessionLineage(m.sessionId, c.hostId);
  try {
    return await turn(ctx, m.sessionId, message);
  } finally {
    try { returnSessionLineage(m.sessionId, c.hostId); } catch (e) {
      logger.error(`[collab ${c.id}] lineage back to ${c.hostId} failed: ${(e as Error).message}`);
    }
  }
}

/**
 * One step: every member `message` gives a message runs a turn, at once;
 * `take` then puts each reply on the record. False when the collab is over.
 */
async function step(
  ctx: Ctx, id: string, phase: CollabPhase,
  message: (c: Collab, m: CollabMember) => string | null,
  take: (c: Collab, m: CollabMember, reply: string) => void,
  before?: (c: Collab) => void,
): Promise<boolean> {
  const c = change(id, (x) => { x.phase = phase; before?.(x); });
  if (!c || c.state !== "running") return false;
  const asked = activeMembers(c).map((m) => ({ m, text: message(c, m) })).filter((a): a is { m: CollabMember; text: string } => a.text !== null);
  const settled = await Promise.all(asked.map((a) => memberTurn(ctx, c, a.m, a.text)));
  const after = change(id, (x) => {
    asked.forEach((a, i) => {
      const rec = x.members.find((y) => y.sessionId === a.m.sessionId);
      const got = settled[i];
      if (!rec) return;
      // A stopped collab's turns were cut off: nobody is dropped for that.
      if ("reply" in got) take(x, rec, got.reply);
      else if (x.state === "running") rec.dropped = got.failed;
    });
  });
  return !!after && after.state === "running";
}

async function research(ctx: Ctx, id: string): Promise<boolean> {
  const takeReport = (c: Collab, m: CollabMember, reply: string) => {
    m.report = clipReport(reply, COLLAB_REPORT_MAX[c.depth]);
    const claims = parseClaims(reply, m.letter);
    c.claims.push(...claims);
    if (claims.length === 0) m.noClaims = true;
  };
  if (!(await step(ctx, id, "research", researchMessage, takeReport))) return false;
  // A report with no claims the app could read gets one more ask, when another step will use them.
  const repaired = await step(ctx, id, "research",
    (c, m) => (c.steps > 1 && m.noClaims && m.report ? claimsRepairMessage(c) : null),
    (c, m, reply) => {
      const claims = parseClaims(reply, m.letter);
      if (claims.length === 0) return;
      c.claims.push(...claims);
      delete m.noClaims;
    });
  if (!repaired) return false;
  const c = change(id, (x) => {
    if (x.state === "running" && !x.members.some((m) => m.report)) end(x, "stopped", "No member gave a report.");
  });
  return !!c && c.state === "running";
}

/** Rounds on what is still disputed, between its two sides, until nobody moves. */
async function settleDisputes(ctx: Ctx, id: string): Promise<boolean> {
  for (let round = 1; round <= COLLAB_DISPUTE_ROUNDS; round++) {
    const c = getCollab(id);
    if (!c || c.state !== "running") return false;
    if (openDisputes(c, true).length === 0) return true;
    const was = disputeSignature(c);
    const running = await step(ctx, id, "dispute", disputeMessage,
      (x, m, reply) => applyResponses(x, m.letter, reply), (x) => { x.disputeRound = round; });
    if (!running) return false;
    const now = getCollab(id);
    if (!now || disputeSignature(now) === was) return true;
  }
  return true;
}

function whenIdle(sessionId: string): Promise<void> {
  if (!hasActiveTurn(sessionId)) return Promise.resolve();
  return new Promise((resolve) => onTurnRelease(sessionId, resolve));
}

/** The starting chat's turn that writes the result, and the check that it named every open dispute. */
async function writeResult(ctx: Ctx, id: string): Promise<void> {
  const c = change(id, (x) => { x.phase = "writing"; });
  if (!c || c.state !== "running") return;
  await whenIdle(c.hostId);
  const first = await turn(ctx, c.hostId, resultMessage(c));
  let note: string | undefined;
  let state: "done" | "stopped" = "done";
  if ("failed" in first) {
    state = "stopped";
    note = "The result could not be written; each member's report is in its own chat.";
  } else if (c.steps > 1) {
    let missing = disputesMissingFrom(c, first.reply);
    if (missing.length) {
      const second = await turn(ctx, c.hostId, missingDisputesMessage(missing));
      missing = disputesMissingFrom(c, `${first.reply}\n${"reply" in second ? second.reply : ""}`);
    }
    if (missing.length) note = `The result does not name ${missing.length === 1 ? "this open dispute" : "these open disputes"}: ${missing.join(", ")}. Ask this chat about ${missing.length === 1 ? "it" : "them"} by id.`;
  }
  change(id, (x) => { if (x.state === "running") end(x, state, note); });
}

/** The collabs this process is running. A record still marked running that is
 *  not here was cut off by a restart. */
const live = new Set<string>();

/** Run a saved collab to its end. Never throws: what went wrong is on the record. */
export async function runCollab(ctx: Ctx, id: string): Promise<void> {
  live.add(id);
  try {
    const steps = getCollab(id)?.steps ?? 0;
    if (!(await research(ctx, id))) return;
    if (steps >= 2 && !(await step(ctx, id, "challenge", challengeMessage, (c, m, reply) => { applyVerdicts(c, m.letter, reply); }))) return;
    if (steps >= 3) {
      const answered = await step(ctx, id, "answer", answerMessage, (c, m, reply) => {
        applyResponses(c, m.letter, reply);
        m.report = clipReport(reply, COLLAB_REPORT_MAX[c.depth]);
      });
      if (!answered || !(await settleDisputes(ctx, id))) return;
    }
    await writeResult(ctx, id);
  } catch (e) {
    logger.error(`[collab ${id}] stopped: ${(e as Error).message}`);
    change(id, (x) => { if (x.state === "running") end(x, "stopped", "It stopped with an error."); });
  } finally {
    live.delete(id);
  }
}

/** Close the record of a collab a restart cut off. */
export function closeIfCutOff(c: Collab): Collab {
  if (c.state !== "running" || live.has(c.id)) return c;
  return change(c.id, (x) => end(x, "stopped", "The app was restarted while it ran; each member's report so far is in its own chat.")) ?? c;
}

/** The user stopped it: no further step runs, and the turns in flight are cut off. */
export function stopCollab(id: string): Collab | null {
  const before = getCollab(id);
  if (!before || before.state !== "running") return before;
  const after = change(id, (x) => end(x, "stopped", "Stopped by the user."));
  for (const m of before.members) abortTurn(m.sessionId);
  if (before.phase === "writing") abortTurn(before.hostId);
  return after;
}

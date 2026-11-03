// On a local wire, the request for a chat's next message starts with the
// request for its last one, byte for byte. A hybrid model (qwen3.8) resumes
// only from checkpoints near the end of the last prompt, so anything dropped
// or rewritten before that end costs the whole prompt: on 2026-11-02 the
// per-op recalled-context row was sent with one message and gone from the
// next, and every message re-read 37k tokens (26-30 s before the first word).
// Drives the real seams: seedOpMessages → buildTurnInput → the local wire,
// then the turn's save (op rows → session rows → withRecallCarried) and the
// next message's seed from that session.
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// The digest's content comes from the session's ledger and task list; here a
// fixed one, for ops routed to a local runtime only, so the other cases keep
// the shape they test.
vi.mock("../turn-loop/situational-awareness.js", () => ({
  buildSituationalAwareness: async (o: Op, turnIdx: number) =>
    o.contextPack?.routing?.preferredProvider === "local" ? `[SITUATIONAL CONTEXT] round ${turnIdx}: recent actions: remember` : null,
}));
import type { Op } from "../../ops/types.js";
import type { PreparedAgentRequest } from "../../agent-request/types.js";
import { seedOpMessages } from "./seed-messages.js";
import { recalledContextText } from "./local-prompt-split.js";
import { buildTurnInput } from "../turn-loop/build-input.js";
import { canonicalToChatParam } from "../adapters/openai-compat/canonical-to-chat-param.js";
import { opMessageRowToChatParam, readOpMessages } from "../index.js";
import { carriedRecallRefs, withRecallCarried } from "../../agent-request/recall-carry.js";
import type { RecalledMemory } from "../../memory/auto-search-context.js";
import { harnessRowKind } from "../../harness-rows.js";
import { writeLocalDigestRow } from "../turn-loop/local-digest-row.js";

let seq = 0;
const newOpId = () => `op_local_across_${Date.now()}_${seq++}`;
const op = (id: string) => ({ id, type: "chat_turn", task: "x", lane: "interactive" } as unknown as Op);
const localOp = (id: string) => ({ ...op(id), contextPack: { routing: { preferredProvider: "local" } } } as unknown as Op);
const prepared = (cleanHistory: ChatCompletionMessageParam[]) => ({ cleanHistory, images: [] } as unknown as PreparedAgentRequest);

const tail = (ref: string, logLine: string) => recalledContextText(
  `<untrusted-recalled-data source="context-block">\n<current_datetime>Today is Monday</current_datetime>\n<today_context>${logLine}</today_context>\n</untrusted-recalled-data>` +
  `<untrusted-recalled-data source="relevant-memories">\n[PAST SESSION — session, ref: ${ref}, session: chat-0]\n[user] I like tea.\n</untrusted-recalled-data>`,
)!;
const recalled = (ref: string): RecalledMemory =>
  ({ entries: [{ ref, text: `[PAST SESSION — session, ref: ${ref}, session: chat-0]\n[user] I like tea.` }], pastSessions: true });

/** Round 0 of a message's op, as the local wire sends it, without an ephemeral digest row. */
async function firstRequest(opId: string, asOp: (id: string) => Op = op): Promise<ChatCompletionMessageParam[]> {
  const input = await buildTurnInput(asOp(opId), 0, null);
  const durable = input.messages.slice(0, input.messages.length - (input.ephemeralTailMessages ?? 0));
  return canonicalToChatParam(durable, undefined);
}

/** What the chat saves for the op: its own rows (not the replayed history), the reply, the recall. */
function savedTurn(opId: string, reply: string, recall: RecalledMemory): ChatCompletionMessageParam[] {
  const rows = readOpMessages(opId)
    .filter((r) => !r.messageId.startsWith("hist-"))
    .map(opMessageRowToChatParam)
    .filter((m): m is ChatCompletionMessageParam => !!m);
  return withRecallCarried([...rows, { role: "assistant", content: reply }], recall);
}

describe("a local chat's next message extends its last one", () => {
  it("message 2's request starts with message 1's, the recalled-context row kept where it was", async () => {
    const op1 = newOpId();
    const t1 = tail("m1", "[20:32:11] User: Yo");
    seedOpMessages(op1, prepared([]), "Yo", t1);
    const request1 = await firstRequest(op1);
    expect(JSON.stringify(request1)).toContain("[20:32:11] User: Yo");

    const session = savedTurn(op1, "Yo Peter, what's good?", recalled("m1"));

    const op2 = newOpId();
    seedOpMessages(op2, prepared(session), "Man that was a cold start", tail("m2", "[20:33:42] User: Man that was a cold start"));
    const request2 = await firstRequest(op2);

    expect(request2.length).toBeGreaterThan(request1.length);
    expect(JSON.stringify(request2.slice(0, request1.length))).toBe(JSON.stringify(request1));
  });

  it("the turn saves the row it was seeded with, exactly as sent, and no second recall row", async () => {
    const opId = newOpId();
    const t = tail("m7", "[09:00:00] User: hi");
    seedOpMessages(opId, prepared([]), "hi", t);
    const saved = savedTurn(opId, "hey", recalled("m7"));
    const recallRows = saved.filter((m) => harnessRowKind(m) === "recall");
    expect(recallRows).toHaveLength(1);
    expect(recallRows[0].content).toBe(t);
    expect(saved.findIndex((m) => harnessRowKind(m) === "recall")).toBe(1);
    // Later messages see its recall as carried, so they do not render it again.
    expect(carriedRecallRefs(saved).has("m7")).toBe(true);
  });

  it("a digest message 1 was sent with is in message 2's history, where it was", async () => {
    // 2026-11-03, qwen3.8: the digest rode after message 1's rows and was never
    // saved, so message 2's request diverged there and re-read 35k tokens.
    const op1 = newOpId();
    seedOpMessages(op1, prepared([]), "Yo", tail("d1", "[12:00:00] User: Yo"));
    await writeLocalDigestRow(localOp(op1), 0);
    const request1 = await firstRequest(op1, localOp);
    expect(JSON.stringify(request1)).toContain("[SITUATIONAL CONTEXT] round 0");

    const session = savedTurn(op1, "Yo Sam", recalled("d1"));
    expect(session.filter((m) => harnessRowKind(m) === "digest")).toHaveLength(1);

    const op2 = newOpId();
    seedOpMessages(op2, prepared(session), "what's new", tail("d2", "[12:01:00] User: what's new"));
    await writeLocalDigestRow(localOp(op2), 0);
    const request2 = await firstRequest(op2, localOp);
    expect(request2.length).toBeGreaterThan(request1.length);
    expect(JSON.stringify(request2.slice(0, request1.length))).toBe(JSON.stringify(request1));
  });

  it("a cloud turn, seeded without the row, still carries its recall the old way", async () => {
    const opId = newOpId();
    seedOpMessages(opId, prepared([]), "hi");
    const saved = savedTurn(opId, "hey", recalled("m9"));
    expect(saved.filter((m) => harnessRowKind(m) === "recall")).toHaveLength(1);
    expect(carriedRecallRefs(saved).has("m9")).toBe(true);
  });
});

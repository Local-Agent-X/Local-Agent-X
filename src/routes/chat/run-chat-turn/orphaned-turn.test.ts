/**
 * A chat turn the server stopped under still reaches its chat. A phone chat cut
 * off on its first turn by a restart left no chat at all (2026-11-18): the turn
 * was saved only by the request that died with the process. Here the op ends
 * after the restart with no live owner, and its committed rows land in the chat
 * through the real persistTurnState, marked interrupted, exactly once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "../../../types.js";
import type { Op } from "../../../ops/types.js";

const { rows, observers } = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
  observers: [] as Array<(op: Op, state: string) => void>,
}));

vi.mock("../../../canonical-loop/index.js", async () => {
  const real = await vi.importActual<typeof import("../../../canonical-loop/public/message-convert.js")>(
    "../../../canonical-loop/public/message-convert.js",
  );
  return {
    readOpMessages: (opId: string) => rows.get(opId) ?? [],
    opMessageRowToChatParam: real.opMessageRowToChatParam,
    registerTerminalObserver: (o: (op: Op, state: string) => void) => { observers.push(o); return () => undefined; },
  };
});

const { claimChatTurn, releaseChatTurn, saveOrphanedChatTurn, watchOrphanedChatTurns } = await import("./orphaned-turn.js");
const { INTERRUPTED_TURN_BOUNDARY } = await import("../../../providers/sanitize.js");

const TASK = "Give me an extremely detailed map of the entire arm";
const op = (id: string, over: Partial<Op> = {}) => ({ id, type: "chat_turn", sessionId: `mobile-${id}`, task: TASK, ...over }) as Op;

function chatCtx() {
  const sessions = new Map<string, Session>();
  const saveSession = vi.fn();
  const ctx = {
    getOrCreateSession: (id: string) => {
      if (!sessions.has(id)) sessions.set(id, { id, title: "New Chat", messages: [], createdAt: 0, updatedAt: 0 } as Session);
      return sessions.get(id)!;
    },
    saveSession,
    memoryManager: { persistTurn: vi.fn(async () => undefined) },
  };
  return { ctx: ctx as never, sessions, saveSession };
}

function committed(opId: string) {
  rows.set(opId, [
    { messageId: `${opId}-u`, role: "user", content: { text: TASK } },
    { messageId: `${opId}-a`, role: "assistant", content: { text: "", toolCalls: [{ id: "tc1", name: "research", arguments: "{}" }] } },
    { messageId: `${opId}-t`, role: "tool_result", content: { toolCallId: "tc1", result: "biceps, brachialis, brachioradialis" } },
  ]);
}

beforeEach(() => { rows.clear(); });

describe("saveOrphanedChatTurn", () => {
  it("puts a cut-off turn's work into its chat, marked interrupted, and makes the chat if it never existed", async () => {
    committed("op1");
    const { ctx, sessions, saveSession } = chatCtx();
    expect(await saveOrphanedChatTurn(op("op1"), false, ctx)).toBe(true);
    const chat = sessions.get("mobile-op1")!;
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chat.messages[0]!.content).toBe(TASK);
    expect(chat.title).toBe(TASK); // under 60 characters: the whole request
    expect(chat.messages.at(-1)).toMatchObject({ content: INTERRUPTED_TURN_BOUNDARY, _interrupted: true });
    expect(saveSession).toHaveBeenCalledWith(chat);
  });

  it("saves a turn that resumed and finished after the restart without the interrupted mark", async () => {
    committed("op2");
    const { ctx, sessions } = chatCtx();
    await saveOrphanedChatTurn(op("op2"), true, ctx);
    expect(sessions.get("mobile-op2")!.messages.some((m) => (m as { _interrupted?: boolean })._interrupted)).toBe(false);
  });

  it("saves a turn once, however many times it is reported", async () => {
    committed("op3");
    const { ctx, sessions } = chatCtx();
    await saveOrphanedChatTurn(op("op3"), false, ctx);
    expect(await saveOrphanedChatTurn(op("op3"), false, ctx)).toBe(false);
    expect(sessions.get("mobile-op3")!.messages).toHaveLength(4);
  });

  it("leaves a turn a live request owns, a turn that committed nothing, and ops that are not chat turns", async () => {
    committed("op4"); committed("op5");
    const { ctx, sessions } = chatCtx();
    claimChatTurn("op4");
    expect(await saveOrphanedChatTurn(op("op4"), false, ctx)).toBe(false);
    releaseChatTurn("op4");
    expect(await saveOrphanedChatTurn(op("op5", { type: "research_query" }), false, ctx)).toBe(false);
    expect(await saveOrphanedChatTurn(op("op6"), false, ctx)).toBe(false);
    expect(sessions.size).toBe(0);
  });
});

describe("watchOrphanedChatTurns", () => {
  it("saves a chat turn when it ends with nobody here to save it", async () => {
    committed("op7"); committed("op8");
    const { ctx, sessions } = chatCtx();
    watchOrphanedChatTurns(() => ctx);
    claimChatTurn("op8");
    for (const o of observers) { o(op("op7"), "failed"); o(op("op8"), "succeeded"); }
    await vi.waitFor(() => expect(sessions.get("mobile-op7")?.messages).toHaveLength(4));
    expect(sessions.has("mobile-op8")).toBe(false);
  });
});

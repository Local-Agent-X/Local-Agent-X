// A spoken turn and a typed turn can land on one session (the voice client
// sends the chat thread's own id). These pin that the spoken turn takes the
// same turn slot, refuses to overwrite a newer turn's history, and only ever
// appends.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { acquireTurn, getActiveTurn, getTurnRegistry, releaseTurn, tryAcquireOrReplace } from "../session/turn-lock.js";
import type { Session } from "../types.js";
import { canaryWatch, claimVoiceTurn, commitVoiceTurn, voiceTurnRows } from "./voice-turn-guard.js";
import type { ThreatEngine } from "../threat/threat-engine.js";

const opRows = new Map<string, { messageId: string; content: string }[]>();
vi.mock("../canonical-loop/index.js", () => ({
  readOpMessages: (opId: string) => opRows.get(opId) ?? [],
  opMessageRowToChatParam: (row: { content: string }) => ({ role: "assistant", content: row.content }),
}));

let seq = 0;
const sid = () => `voice-guard-${seq++}`;
const session = (id: string, messages: ChatCompletionMessageParam[] = []): Session =>
  ({ id, title: "t", messages, createdAt: 0, updatedAt: 0 }) as unknown as Session;
const opened: string[] = [];
afterEach(() => { for (const id of opened.splice(0)) releaseTurn(id); });

describe("claimVoiceTurn — the session's one turn slot", () => {
  it("takes a free slot, and a barge-in aborts the turn", async () => {
    const id = sid(); opened.push(id);
    const bargeIn = new AbortController();
    const slot = await claimVoiceTurn(id, bargeIn.signal);
    expect(slot).not.toBeNull();
    expect(getActiveTurn(id)).not.toBeNull();
    bargeIn.abort();
    expect(slot!.signal.aborted).toBe(true);
    slot!.release();
    expect(getActiveTurn(id)).toBeNull();
  });

  it("is refused while a typed turn that has committed something runs", async () => {
    const id = sid(); opened.push(id);
    acquireTurn(id, new AbortController(), "chat");
    getTurnRegistry().markIteration(id, ["bash"]);
    expect(await claimVoiceTurn(id, new AbortController().signal)).toBeNull();
  });

  it("replaces a typed turn that has committed nothing (aborts it, then takes the slot)", async () => {
    const id = sid(); opened.push(id);
    const typed = new AbortController();
    acquireTurn(id, typed, "chat");
    setTimeout(() => releaseTurn(id), 10); // the typed turn's handler finishing
    const slot = await claimVoiceTurn(id, new AbortController().signal);
    expect(typed.signal.aborted).toBe(true);
    expect(slot).not.toBeNull();
  });

  it("release never gives back a newer turn's slot", async () => {
    const id = sid(); opened.push(id);
    const slot = await claimVoiceTurn(id, new AbortController().signal);
    // A typed message replaces the spoken turn (it committed nothing); the
    // spoken handler is slow, so the 5 s net force-releases it.
    vi.useFakeTimers();
    const typed = tryAcquireOrReplace(id, new AbortController(), "chat");
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    expect((await typed).allowed).toBe(true);
    slot!.release();
    expect(getActiveTurn(id)).not.toBeNull();
  });
});

describe("commitVoiceTurn", () => {
  const rows: ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];

  it("appends the turn, runs the memory pass, and saves", async () => {
    const id = sid(); opened.push(id);
    const slot = await claimVoiceTurn(id, new AbortController().signal);
    const s = session(id, [{ role: "user", content: "typed earlier" }]);
    const persistTurn = vi.fn(async () => {});
    const saveSession = vi.fn();
    expect(await commitVoiceTurn({ session: s, sessionId: id, turnSignal: slot!.signal, rows, turnMessages: rows, userText: "hi", replyText: "hello", memoryManager: { persistTurn }, saveSession })).toBe(true);
    expect(s.messages.map((m) => m.content)).toEqual(["typed earlier", "hi", "hello"]);
    expect(persistTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: "hi", agentResponse: "hello", sessionId: id }));
    // The memory pass gets the turn's rows: with null it declines every spoken
    // turn as "not provably clean" and saves no fact from a voice call.
    expect(persistTurn).toHaveBeenCalledWith(expect.objectContaining({ turnMessages: rows }));
    expect(saveSession).toHaveBeenCalledWith(s);
  });

  it("a turn a newer one replaced saves nothing", async () => {
    const id = sid(); opened.push(id);
    const slot = await claimVoiceTurn(id, new AbortController().signal);
    vi.useFakeTimers();
    const typed = tryAcquireOrReplace(id, new AbortController(), "chat");
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await typed;
    const s = session(id, [{ role: "user", content: "the newer turn's row" }]);
    const saveSession = vi.fn();
    expect(await commitVoiceTurn({ session: s, sessionId: id, turnSignal: slot!.signal, rows, turnMessages: rows, userText: "hi", replyText: "hello", memoryManager: { persistTurn: vi.fn() }, saveSession })).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe("canaryWatch", () => {
  it("aborts the turn when the canary shows up across deltas", () => {
    const engine = { checkOutput: (t: string) => (t.includes("CANARY-123") ? "canary" : null) } as unknown as ThreatEngine;
    const abort = vi.fn();
    const tripped = canaryWatch(engine, abort);
    expect(tripped("the token is CAN")).toBe(false);
    expect(tripped("ARY-123")).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("voiceTurnRows", () => {
  it("reads the op's own rows, without the replayed history", async () => {
    opRows.set("op-1", [
      { messageId: "hist-0", content: "earlier" },
      { messageId: "m-1", content: "tool result" },
      { messageId: "m-2", content: "spoken reply" },
    ]);
    expect(await voiceTurnRows("op-1")).toEqual([
      { role: "assistant", content: "tool result" },
      { role: "assistant", content: "spoken reply" },
    ]);
  });

  it("is null when there is no op or it has no rows, so the memory pass declines", async () => {
    expect(await voiceTurnRows(undefined)).toBeNull();
    expect(await voiceTurnRows("op-missing")).toBeNull();
  });
});

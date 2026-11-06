// A spoken turn and a typed turn can land on one session (the voice client
// sends the chat thread's own id). These pin that the spoken turn takes the
// same turn slot, refuses to overwrite a newer turn's history, and only ever
// appends.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { acquireTurn, getActiveTurn, getTurnRegistry, releaseTurn, tryAcquireOrReplace } from "../session/turn-lock.js";
import type { Session } from "../types.js";
import { canaryWatch, carriedCardRows, carriedHarnessRows, claimVoiceTurn, commitVoiceTurn, isCardMetadata, voiceTurnRows } from "./voice-turn-guard.js";
import { markHarnessRow } from "../harness-rows.js";
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

describe("carriedHarnessRows — what a local spoken turn read that the next request replays", () => {
  const recall = (text: string) => markHarnessRow({ role: "user", content: text }, "recall");
  const history: ChatCompletionMessageParam[] = [{ role: "user", content: "earlier" }, recall("old recall"), { role: "assistant", content: "ok" }];

  it("keeps this turn's recall and digest rows, in order, and nothing from history", () => {
    const digest = markHarnessRow({ role: "user", content: "digest" }, "digest");
    const turn: ChatCompletionMessageParam[] = [
      { role: "system", content: "S" }, ...history, { role: "user", content: "hi" },
      recall("new recall"), digest, { role: "assistant", content: "hello" },
    ];
    expect(carriedHarnessRows(turn, history.length)).toEqual([recall("new recall"), digest]);
  });

  it("leaves out nudges, which belong to tool rounds a spoken turn does not save", () => {
    const turn: ChatCompletionMessageParam[] = [
      { role: "system", content: "S" }, ...history, { role: "user", content: "hi" },
      markHarnessRow({ role: "user", content: "keep going" }, "nudge"), { role: "assistant", content: "hello" },
    ];
    expect(carriedHarnessRows(turn, history.length)).toEqual([]);
  });
});

describe("carriedCardRows: the cards a spoken turn showed, saved like a typed turn's", () => {
  it("keeps only the show_card calls and their results, metadata and all, in order", () => {
    const history = [{ role: "user" as const, content: "earlier" }];
    const card = { title: "Glider", image: "/images/cards/a.jpg" };
    const cardCall = { id: "c1", type: "function" as const, function: { name: "show_card", arguments: "{\"title\":\"Glider\"}" } };
    const cardResult = { role: "tool" as const, tool_call_id: "c1", content: "Shown", _metadata: { card } };
    const turn = [
      { role: "system" as const, content: "sys" },
      ...history,
      { role: "user" as const, content: "show me gliders" },
      {
        role: "assistant" as const, content: "",
        tool_calls: [{ id: "b1", type: "function" as const, function: { name: "browser", arguments: "{}" } }, cardCall],
      },
      { role: "tool" as const, tool_call_id: "b1", content: "page" },
      cardResult,
      { role: "assistant" as const, content: "Here's one." },
    ];
    const rows = carriedCardRows(turn as never, history.length);
    expect(rows).toEqual([{ role: "assistant", content: "", tool_calls: [cardCall] }, cardResult]);
  });

  it("carries none for a turn that showed no card", () => {
    expect(carriedCardRows([{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hey" }], 0)).toEqual([]);
  });

  it("knows a card's metadata from any other", () => {
    expect(isCardMetadata({ card: { title: "Glider" } })).toBe(true);
    expect(isCardMetadata({ fileChange: {} })).toBe(false);
    expect(isCardMetadata(undefined)).toBe(false);
  });
});

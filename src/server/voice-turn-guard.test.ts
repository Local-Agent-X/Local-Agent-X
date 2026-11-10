// A spoken turn and a typed turn can land on one session (the voice client
// sends the chat thread's own id). These pin that the spoken turn takes the
// same turn slot, refuses to overwrite a newer turn's history, and only ever
// appends.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { acquireTurn, getActiveTurn, getTurnRegistry, releaseTurn, tryAcquireOrReplace } from "../session/turn-lock.js";
import type { Session } from "../types.js";
import { canaryWatch, carriedToolRows, carriedHarnessRows, claimVoiceTurn, commitVoiceTurn, isCardMetadata, spokenUserRow, voiceTurnRows } from "./voice-turn-guard.js";
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

describe("carriedToolRows: what a spoken turn did, saved like a typed turn's rows", () => {
  const history = [{ role: "user" as const, content: "earlier" }];
  const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
  const result = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ role: "tool" as const, tool_call_id: id, content, ...extra });
  const turnOf = (...rows: unknown[]) => [{ role: "system" as const, content: "sys" }, ...history, { role: "user" as const, content: "email jenny" }, ...rows];

  it("keeps every call and its result, a hand-off to a worker included, with the spoken text left to the reply", () => {
    // A call that handed an email to a worker left no trace, and a typed turn
    // later could not tell a send was underway.
    const handoff = call("h1", "op_submit_async");
    const card = result("c1", "Shown", { _metadata: { card: { title: "Glider" } } });
    const turn = turnOf(
      { role: "assistant", content: "Sure, sending it now.", tool_calls: [handoff, call("c1", "show_card")] },
      result("h1", "Submitted op_send_email_da72 (running in background)"),
      card,
      { role: "assistant", content: "It's going out now." },
    );
    expect(carriedToolRows(turn as never, history.length)).toEqual([
      { role: "assistant", content: "", tool_calls: [handoff, call("c1", "show_card")] },
      result("h1", "Submitted op_send_email_da72 (running in background)"),
      card,
    ]);
  });

  it("never saves a call without its result: a turn cut off mid-tool keeps only what was answered", () => {
    const turn = turnOf(
      { role: "assistant", content: "", tool_calls: [call("a1", "web_search"), call("a2", "browser")] },
      result("a1", "results"),
      { role: "assistant", content: "", tool_calls: [call("b1", "browser")] },
      result("zz", "a result whose call is gone"),
    );
    expect(carriedToolRows(turn as never, history.length)).toEqual([
      { role: "assistant", content: "", tool_calls: [call("a1", "web_search")] },
      result("a1", "results"),
    ]);
  });

  it("leaves out the image rows a tool added for the model to look at", () => {
    const turn = turnOf(
      { role: "assistant", content: "", tool_calls: [call("s1", "screen_capture")] },
      result("s1", "captured"),
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "That's your editor." },
    );
    expect(carriedToolRows(turn as never, history.length).map((m) => m.role)).toEqual(["assistant", "tool"]);
  });

  it("carries none for a turn that called no tool", () => {
    expect(carriedToolRows([{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hey" }], 0)).toEqual([]);
  });

  it("knows a card's metadata from any other", () => {
    expect(isCardMetadata({ card: { title: "Glider" } })).toBe(true);
    expect(isCardMetadata({ fileChange: {} })).toBe(false);
    expect(isCardMetadata(undefined)).toBe(false);
  });
});

describe("spokenUserRow — what the user's spoken message keeps", () => {
  // Peter, 2026-11-09: each camera frame showed in the chat as a photo, which broke the
  // feel of the agent having eyes. The agent sees a frame on its turn; the row keeps none.
  it("keeps a photo the user shared, and leaves out the camera's frame the agent glanced at", () => {
    const row = spokenUserRow("what is this", [
      { name: "photo-1.jpg", url: "/uploads/a.jpg" },
      { name: "camera.jpg", url: "/uploads/b.jpg", glance: true },
    ]);
    expect(row).toEqual({ role: "user", content: "what is this", images: [{ name: "photo-1.jpg", url: "/uploads/a.jpg" }] });
  });

  it("is plain words when all it had were glances", () => {
    expect(spokenUserRow("do you see it", [{ name: "camera.jpg", url: "/uploads/b.jpg", glance: true }])).toEqual({ role: "user", content: "do you see it" });
  });
});

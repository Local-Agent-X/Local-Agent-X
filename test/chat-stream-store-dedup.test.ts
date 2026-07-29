// @vitest-environment happy-dom
//
// Regression: the assistant's reply was duplicated — re-spliced at the top of
// the chat — when an op went silent and the stuck-stream watchdog re-fired
// reconnect_op. The server replays a SECOND `{type:"done"}` for the already-
// finalized op (state_changed→succeeded), which re-runs finalize →
// promoteLiveToMessages. The live scratch was still populated and
// liveAnchorIndex === -1, so raw=-1 → idx=0 → the same row was spliced again
// at index 0. One extra done = 2× dup; many stalls = many dones = 6-10×.
//
// Fix: promoteLiveToMessages clears the live scratch (content/toolEvents/etc.)
// after a successful splice, so the empty-scratch guard makes the second
// promote a no-op returning null. This test drives a double-`done` through the
// real IIFE and asserts a single assistant message survives.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type StreamEvent = {
  type: string; delta?: string; text?: string; replace?: boolean;
  toolName?: string; toolCallId?: string; result?: string;
  /** Durable/live approval ask (chat-approval-rediscovery.js hydrates these
   *  through the same reducer the live event uses). */
  approvalId?: string; argsPreview?: string; expiresAt?: number;
  /** Op attribution — the owning op of a live frame, and (on
   *  chat_op_started) the op a turn takeover replaced. */
  opId?: string; supersedes?: string;
};
interface ToolEvent { type?: string; name?: string; toolCallId?: string }
interface ApprovalCard { id: string; status: string; opId: string | null }
interface ChatMessage { role: string; content: string; _tools?: ToolEvent[] }
interface FakeChat { messages: ChatMessage[] }
interface StoreEntry { content: string; toolEvents: ToolEvent[]; approvals: ApprovalCard[] }
interface Store {
  startTurn(sessionId: string, anchorIdx?: number): unknown;
  applyEvent(sessionId: string, event: StreamEvent): void;
  promoteLiveToMessages(sessionId: string, chat: FakeChat): ChatMessage | null;
  get(sessionId: string): StoreEntry | null;
}

let ChatStreamStore: Store;

beforeEach(() => {
  // The store is browser IIFEs that assign window.ChatStreamStore — split
  // across blocks/reducer/core (app.html load order). Load and execute the
  // sources fresh per test so the internal Map starts empty — the core
  // closes over module-level state with no reset hook.
  for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
    const src = readFileSync(join(here, "../public/js/" + f), "utf8");
    // eslint-disable-next-line no-new-func
    new Function(src)();
  }
  ChatStreamStore = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
});

describe("ChatStreamStore.promoteLiveToMessages — double-done dedup", () => {
  const sessionId = "chat-dedup";

  it("promotes once and survives a watchdog-replayed second done without duplicating", () => {
    const chat: FakeChat = { messages: [] };

    // Turn one: stream a reply, finalize on the first `done`.
    ChatStreamStore.startTurn(sessionId, 0);
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Hi Alex. Bob here." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const first = ChatStreamStore.promoteLiveToMessages(sessionId, chat);

    expect(first).not.toBeNull();
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: "assistant", content: "Hi Alex. Bob here." });

    // The stuck-stream watchdog fires reconnect_op; the server replays a SECOND
    // `done` for the same (already-finalized) op, re-running finalize.
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const second = ChatStreamStore.promoteLiveToMessages(sessionId, chat);

    // No duplicate: the second promote is a no-op (returns null) and nothing is
    // spliced — in particular nothing lands at index 0.
    expect(second).toBeNull();
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: "assistant", content: "Hi Alex. Bob here." });
  });

  it("stays at one message across MANY replayed dones (the 6-10x field report)", () => {
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sessionId, 0);
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Done." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    expect(ChatStreamStore.promoteLiveToMessages(sessionId, chat)).not.toBeNull();

    for (let i = 0; i < 9; i++) {
      ChatStreamStore.applyEvent(sessionId, { type: "done" });
      ChatStreamStore.promoteLiveToMessages(sessionId, chat);
    }
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].content).toBe("Done.");
  });
});

describe("ChatStreamStore.applyEvent — turn-boundary separation", () => {
  const sessionId = "chat-turns";

  it("opens a paragraph break between consecutive turns instead of running text together", () => {
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sessionId, 0);

    // Turn 1: text, then a tool call.
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Step 1 done at 2026 ." });
    ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sessionId, { type: "tool_end", toolName: "bash", toolCallId: "c1" });
    // Turn 2: the model's next text must not glue onto "...2026 .".
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Step 2 completed." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });

    const msg = ChatStreamStore.promoteLiveToMessages(sessionId, chat);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe("Step 1 done at 2026 .\n\nStep 2 completed.");
  });

  it("does not insert a break for deltas within the same turn", () => {
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sessionId, 0);
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Hello " });
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "world." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const msg = ChatStreamStore.promoteLiveToMessages(sessionId, chat);
    expect(msg!.content).toBe("Hello world.");
  });

  it("does not double up when the prior turn already ended with a newline", () => {
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sessionId, 0);
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Line one\n" });
    ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sessionId, { type: "tool_end", toolName: "bash", toolCallId: "c1" });
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Line two" });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const msg = ChatStreamStore.promoteLiveToMessages(sessionId, chat);
    expect(msg!.content).toBe("Line one\nLine two");
  });
});

// Turn takeover: the user sends again while a turn is still live, the server
// aborts that turn and starts a replacement on the SAME session. The dead op's
// provider stream keeps flushing for a beat, so two ops' output used to land in
// one bubble — the store was keyed on sessionId alone and the scratch wipe on a
// new op only fired for an entry already 'done'. Live envelopes now carry their
// owning opId (src/chat-ws/manager.ts) and chat_op_started names the op it
// replaced, so the dead turn is retired instead of rendered.
describe("ChatStreamStore.applyEvent — turn takeover on one session", () => {
  const sessionId = "chat-takeover";

  it("keeps only the replacement op's output, and still accepts un-stamped frames", () => {
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sessionId, 0);

    // Op A is live and has already streamed part of an answer.
    ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Dead draft.", opId: "op-A" });

    // The user sends again — op B takes the session over and names op A.
    ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });

    // Op A's stream flushes buffered output after the abort. None of it
    // belongs to the turn now on screen.
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: " More dead text.", opId: "op-A" });
    ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "dead-1", opId: "op-A" });

    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Live answer.", opId: "op-B" });
    // Un-stamped frames come from emitters that predate op attribution (and
    // from replay's synthesized run deltas) — they must land exactly as before.
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: " Unstamped tail." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });

    // Read the live scratch before promoting — promote clears it.
    const live = ChatStreamStore.get(sessionId)!;
    expect(live.content).toBe("Live answer. Unstamped tail.");
    // The dead op's tool card never entered the timeline either.
    expect(live.toolEvents).toHaveLength(0);

    const msg = ChatStreamStore.promoteLiveToMessages(sessionId, chat);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe("Live answer. Unstamped tail.");
  });

  // The tab that CAUSED the takeover, in its real event order. chat-send.js
  // calls startTurn the moment the user hits send — long before the server has
  // prepared, taken the turn lock away from the dead op, and announced the
  // replacement — and startTurn clears e.opId. So by the time
  // chat_op_started{supersedes} lands, the entry no longer names the op it was
  // rendering: keying the wipe on e.opId alone made it fire ONLY for passive
  // observer tabs, i.e. never for the one tab that actually streams the dead
  // op's output into the new turn's bubble.
  it("wipes the dead op's leftovers for the tab that SENT the second message", () => {
    const sid = "chat-takeover-sender";
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sid, 0);

    // Op A is live and part-way through an answer.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "A partial.", opId: "op-A" });

    // The user sends again — send-time startTurn, no op id known yet.
    ChatStreamStore.startTurn(sid, 0);

    // Prepare + tryAcquireOrReplace window (up to the 5s safety net when the
    // prior turn wedges): op A keeps flushing, and nothing has retired it yet.
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "DEAD A TEXT", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "tool_start", toolName: "bash", toolCallId: "dead-1", opId: "op-A" });

    // The replacement announces itself and names the op it replaced.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "tool_end", toolName: "bash", toolCallId: "dead-1", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Live B answer.", opId: "op-B" });
    ChatStreamStore.applyEvent(sid, { type: "done" });

    const live = ChatStreamStore.get(sid)!;
    expect(live.content).toBe("Live B answer.");
    expect(live.toolEvents).toHaveLength(0);

    // ...and none of the dead op's output is persisted.
    const msg = ChatStreamStore.promoteLiveToMessages(sid, chat);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe("Live B answer.");
    expect(msg!._tools).toBeUndefined();
  });

  // The parked id names ONE specific takeover, and only for as long as this
  // entry is still the one startTurn left behind (opId back to null). Five
  // conditions line this up otherwise: a live op A, a second send (which parks
  // A), the prior turn wedged past the lock's 5s safety net so the takeover is
  // still unannounced, a WS reconnect inside that window, and a durable pending
  // approval on the same session owned by a DIFFERENT op. Rediscovery
  // (chat-approval-rediscovery.js:49-50) then replays chat_op_started{op-X} +
  // approval_requested, so the entry is rendering op X by the time the real
  // takeover names op A — matching the parked id alone at that point wipes
  // content AND approvals, destroying a card the takeover has nothing to do
  // with. Guarding on e.opId keeps the parked match to the entry it was parked
  // for.
  it("does not wipe an interposed op's approval card when only the parked id matches", () => {
    const sid = "chat-takeover-interposed";
    ChatStreamStore.startTurn(sid, 0);

    // Op A is live and part-way through an answer; the user sends again, so
    // send-time startTurn parks op A and clears e.opId.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "A partial.", opId: "op-A" });
    ChatStreamStore.startTurn(sid, 0);

    // Inside the wedged lock window the WS reconnects and rediscovery hydrates
    // a durable ask owned by op X — a different op on the same session.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-X" });
    ChatStreamStore.applyEvent(sid, {
      type: "approval_requested", approvalId: "ap-1", toolName: "bash",
      opId: "op-X", expiresAt: Date.now() + 60_000,
    });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "X needs approval.", opId: "op-X" });

    // Only now does the replacement announce itself, naming op A.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });

    // The card op X is blocked on is still on screen, with its scratch.
    const live = ChatStreamStore.get(sid)!;
    expect(live.approvals.map(a => a.id)).toEqual(["ap-1"]);
    expect(live.approvals[0].status).toBe("pending");
    expect(live.content).toBe("X needs approval.");
  });

  // The other leg of the guard: a reconnect can replay the still-live op A's
  // own chat_op_started after the park, putting e.opId BACK to op A. That is
  // the entry the park was for, so the wipe must still fire — the guard is
  // "not some other op", not "opId must be null".
  it("still wipes when a replayed start restored the parked op as the entry's opId", () => {
    const sid = "chat-takeover-replayed-start";
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "A partial.", opId: "op-A" });
    ChatStreamStore.startTurn(sid, 0);

    // Subscribe replay re-announces the op that is still (wedged) live.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "DEAD A TEXT", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Live B answer.", opId: "op-B" });

    expect(ChatStreamStore.get(sid)!.content).toBe("Live B answer.");
  });

  // The other side of the same takeover: a tab that never sent anything and
  // never ran startTurn (it adopted the turn, or was just watching). Its
  // identity for the dead op is e.opId, learned from op A's own announcement.
  it("wipes the dead op's leftovers for a passive observer tab too", () => {
    const sid = "chat-takeover-observer";
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Dead draft.", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Live answer.", opId: "op-B" });

    expect(ChatStreamStore.get(sid)!.content).toBe("Live answer.");
  });

  // Half a pair is worse than the whole pair: chat-render-artifacts.js pairs
  // tool starts to ends, so a start left without its end renders as a
  // never-completing card — permanently, once promoteLiveToMessages persists
  // it. The WS path never calls endTurn, so nothing synthesizes the
  // "(interrupted)" close either.
  it("never orphans a rendered tool card when the op is retired mid-flight", () => {
    const sid = "chat-takeover-orphan";
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-A" });
    ChatStreamStore.applyEvent(sid, { type: "tool_start", toolName: "bash", toolCallId: "t1", opId: "op-A" });
    // Durable-approval rediscovery replays a bare chat_op_started for an
    // unrelated pending op (chat-approval-rediscovery.js), so this entry is
    // no longer rendering op A and the takeover below cannot wipe its card.
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-X" });
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-B", supersedes: "op-A" });

    // Op A's tool actually finished. Its end has to close the card on screen.
    ChatStreamStore.applyEvent(sid, { type: "tool_end", toolName: "bash", toolCallId: "t1", result: "ok", opId: "op-A" });
    const live = ChatStreamStore.get(sid)!;
    expect(live.toolEvents.filter(t => t.type === "end" && t.toolCallId === "t1")).toHaveLength(1);

    // A dead op's end with no card on screen stays dropped — the exception is
    // the pairing invariant, not a hole in the retirement.
    ChatStreamStore.applyEvent(sid, { type: "tool_end", toolName: "bash", toolCallId: "ghost", opId: "op-A" });
    expect(live.toolEvents.some(t => t.toolCallId === "ghost")).toBe(false);
  });

  it("keeps frames stamped with an op that was never superseded", () => {
    // Guard against over-dropping: op attribution alone must change nothing.
    const sid = "chat-takeover-solo";
    const chat: FakeChat = { messages: [] };
    ChatStreamStore.startTurn(sid, 0);
    ChatStreamStore.applyEvent(sid, { type: "chat_op_started", opId: "op-solo" });
    ChatStreamStore.applyEvent(sid, { type: "stream", delta: "Kept.", opId: "op-solo" });
    ChatStreamStore.applyEvent(sid, { type: "tool_start", toolName: "bash", toolCallId: "c1", opId: "op-solo" });
    ChatStreamStore.applyEvent(sid, { type: "done" });

    expect(ChatStreamStore.get(sid)!.toolEvents).toHaveLength(1);
    expect(ChatStreamStore.promoteLiveToMessages(sid, chat)!.content).toBe("Kept.");
  });
});

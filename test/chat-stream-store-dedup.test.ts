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

type StreamEvent = { type: string; delta?: string; text?: string; replace?: boolean };
interface ChatMessage { role: string; content: string }
interface FakeChat { messages: ChatMessage[] }
interface Store {
  startTurn(sessionId: string, anchorIdx?: number): unknown;
  applyEvent(sessionId: string, event: StreamEvent): void;
  promoteLiveToMessages(sessionId: string, chat: FakeChat): ChatMessage | null;
}

let ChatStreamStore: Store;

beforeEach(() => {
  // The module is a browser IIFE that assigns window.ChatStreamStore. Load and
  // execute the source fresh per test so the internal Map starts empty — it
  // closes over module-level state with no reset hook.
  const src = readFileSync(join(here, "../public/js/chat-stream-store.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(src)();
  ChatStreamStore = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
});

describe("ChatStreamStore.promoteLiveToMessages — double-done dedup", () => {
  const sessionId = "chat-dedup";

  it("promotes once and survives a watchdog-replayed second done without duplicating", () => {
    const chat: FakeChat = { messages: [] };

    // Turn one: stream a reply, finalize on the first `done`.
    ChatStreamStore.startTurn(sessionId, 0);
    ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "Hi Peter. Bob here." });
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const first = ChatStreamStore.promoteLiveToMessages(sessionId, chat);

    expect(first).not.toBeNull();
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: "assistant", content: "Hi Peter. Bob here." });

    // The stuck-stream watchdog fires reconnect_op; the server replays a SECOND
    // `done` for the same (already-finalized) op, re-running finalize.
    ChatStreamStore.applyEvent(sessionId, { type: "done" });
    const second = ChatStreamStore.promoteLiveToMessages(sessionId, chat);

    // No duplicate: the second promote is a no-op (returns null) and nothing is
    // spliced — in particular nothing lands at index 0.
    expect(second).toBeNull();
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: "assistant", content: "Hi Peter. Bob here." });
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

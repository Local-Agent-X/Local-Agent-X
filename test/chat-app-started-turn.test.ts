// @vitest-environment happy-dom
//
// A turn the app starts by itself (a background worker ended and LAX woke the
// chat to report it) on a desktop that is showing that chat. Label Check Sol,
// 2026-11-27: the phone showed the turn and its question live; the desktop,
// open on the same chat, showed nothing until the owner answered from the
// phone. Drives the REAL client sources: the stream store, the chat event
// dispatcher and the cross-device message echo, with the frames such a turn
// sends: user_message (the app's text), chat_op_started, stream, done.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
type Row = { role: string; content: unknown };
type Chat = { id: string; messages: Row[] };

const SESSION = "chat-app-started";
const APP_TEXT = "(Sent by the app, not typed by the user: background work you started has ended.)\nReport it to the user.";
let finalized: string[];

function load(chat: Chat): { dispatch: (msg: unknown) => unknown; echo: (msg: unknown) => unknown } {
  const g = globalThis as unknown as Record<string, unknown>;
  const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
  for (const f of ["agentxos-timeline.js", "chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
    new Function(src(f))();
  }
  const store = (g.window as { ChatStreamStore: { promoteLiveToMessages(s: string, c: Chat): unknown } }).ChatStreamStore;
  g.ChatStreamStore = store;
  g.activeChat = chat;
  g.chats = [chat];
  g.renderMessages = () => {};
  g.rerenderLiveMessage = () => {};
  g.feedTTS = () => {};
  g.updateContextBar = () => {};
  g.saveChats = () => {};
  finalized = [];
  // The send path's finalize, reduced to what it does to the chat: promote the live row.
  g._finalizeWsTurn = (sessionId: string, c: Chat) => { store.promoteLiveToMessages(sessionId, c); finalized.push(sessionId); };
  const events = new Function(src("chat-ws-handler-chat-events.js") + "\nreturn { dispatchChatStreamEvent };")() as { dispatchChatStreamEvent: (m: unknown) => unknown };
  const echo = new Function("chats", "activeChat", "renderMessages", "saveChats",
    src("chat-message-echo.js") + "\nreturn { handleUserMessageEcho };")([chat], chat, () => {}, () => {}) as { handleUserMessageEcho: (m: unknown) => unknown };
  return { dispatch: events.dispatchChatStreamEvent, echo: echo.handleUserMessageEcho };
}

const frame = (event: Record<string, unknown>) => ({ type: "event", sessionId: SESSION, event });

beforeEach(() => { document.body.innerHTML = ""; });

describe("a turn the app started, on a desktop showing the chat", () => {
  it("shows the app's note and the reply, as the turn ends", () => {
    const chat: Chat = { id: SESSION, messages: [{ role: "user", content: "try the phone again" }, { role: "assistant", content: "Started the test." }] };
    const { dispatch, echo } = load(chat);
    echo(frame({ type: "user_message", text: APP_TEXT }));
    dispatch(frame({ type: "chat_op_started", opId: "op_chat_turn_wake" }));
    dispatch(frame({ type: "stream", delta: "The test compiled. May I queue one preview build?" }));
    dispatch(frame({ type: "done", opId: "op_chat_turn_wake" }));
    expect(finalized).toEqual([SESSION]);
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(String(chat.messages[3].content)).toContain("May I queue one preview build?");
  });
});

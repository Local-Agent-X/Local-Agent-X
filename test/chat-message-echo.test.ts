// The user's message from another device shows in the open chat once, with its
// pictures; the device that sent it already shows it and adds nothing.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
type Row = { role: string; content: unknown; attachments?: unknown; images?: unknown };
type Chat = { id: string; messages: Row[] };
type Echo = { handleUserMessageEcho: (msg: unknown) => boolean; userRowAttachments: (msg: unknown) => unknown };

let load: (chats: Chat[], activeChat: Chat | null, renderMessages: () => void) => Echo;

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-message-echo.js"), "utf8");
  load = (chats, activeChat, renderMessages) =>
    // eslint-disable-next-line no-new-func
    new Function("chats", "activeChat", "renderMessages", "saveChats",
      src + "\nreturn { handleUserMessageEcho, userRowAttachments };")(chats, activeChat, renderMessages, () => {}) as Echo;
});

const echo = (sessionId: string, text: string, images?: unknown) =>
  ({ type: "event", sessionId, event: { type: "user_message", text, ...(images ? { images } : {}) } });

describe("chat-message-echo", () => {
  it("adds a message sent from another device, with its pictures, and repaints the open chat", () => {
    const chat: Chat = { id: "s1", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] };
    const render = vi.fn();
    const { handleUserMessageEcho } = load([chat], chat, render);
    handleUserMessageEcho(echo("s1", "look at this", [{ name: "a.jpg", url: "/uploads/att-1.jpg" }]));
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[2]).toMatchObject({
      role: "user", content: "look at this",
      attachments: [{ name: "a.jpg", url: "/uploads/att-1.jpg", isImage: true }],
    });
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("leaves the sender's own message alone, the replayed copy too", () => {
    const chat: Chat = { id: "s1", messages: [{ role: "assistant", content: "hello" }, { role: "user", content: "Attached files:\n- a.jpg\n\nyes" }] };
    const { handleUserMessageEcho } = load([chat], chat, vi.fn());
    handleUserMessageEcho(echo("s1", "yes"));
    handleUserMessageEcho(echo("s1", "yes"));
    expect(chat.messages).toHaveLength(2);
  });

  it("adds a repeat of an earlier message: only this turn's rows count", () => {
    const chat: Chat = { id: "s1", messages: [{ role: "user", content: "yes" }, { role: "assistant", content: "ok" }] };
    const { handleUserMessageEcho } = load([chat], chat, vi.fn());
    handleUserMessageEcho(echo("s1", "yes"));
    expect(chat.messages).toHaveLength(3);
  });

  // 2026-11-27: a reconnect replayed a finished Grok turn, and its echo put the
  // owner's first message again at the end, under the reply.
  it("a replayed echo of a turn whose reply is already shown adds nothing", () => {
    const chat: Chat = { id: "s1", messages: [{ role: "user", content: "build the shop helper" }, { role: "assistant", content: "stuck" }] };
    const { handleUserMessageEcho } = load([chat], chat, vi.fn());
    handleUserMessageEcho({ ...echo("s1", "build the shop helper"), _replay: true });
    expect(chat.messages).toHaveLength(2);
    // A replay of a message the chat does not have yet still shows it.
    handleUserMessageEcho({ ...echo("s1", "r u ok"), _replay: true });
    expect(chat.messages.map((m) => m.content)).toEqual(["build the shop helper", "stuck", "r u ok"]);
  });

  it("ignores a chat this window does not hold, and does not repaint a chat that is not open", () => {
    const open: Chat = { id: "s1", messages: [] };
    const other: Chat = { id: "s2", messages: [] };
    const render = vi.fn();
    const { handleUserMessageEcho } = load([open, other], open, render);
    expect(handleUserMessageEcho(echo("nope", "x"))).toBe(true);
    handleUserMessageEcho(echo("s2", "from the phone"));
    expect(other.messages).toHaveLength(1);
    expect(render).not.toHaveBeenCalled();
  });

  it("draws a stored message's server images when it has no attachments of its own", () => {
    const { userRowAttachments } = load([], null, vi.fn());
    expect(userRowAttachments({ images: [{ name: "p.png", url: "/uploads/p.png" }] })).toEqual([
      { name: "p.png", url: "/uploads/p.png", isImage: true, size: 0, type: "" },
    ]);
    const own = [{ name: "x", isImage: true, dataUrl: "data:," }];
    expect(userRowAttachments({ attachments: own, images: [{ url: "/uploads/p.png" }] })).toBe(own);
    expect(userRowAttachments({})).toBeUndefined();
  });
});

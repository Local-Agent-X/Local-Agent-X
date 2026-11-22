// The Send now frame: a shell command the chat waits on moves to the
// background only while the user's message is still queued, and the tab is
// told how many moved (the button's "reading it now" vs "after this step").
import { afterEach, describe, expect, it } from "vitest";
import { handleSendNow } from "./inject-router.js";
import { holdForSendNow } from "../tools/shell-handoff.js";
import { drainInjects, pushInject } from "../agent-loop/inject-queue.js";

const CHAT = "chat-send-now-frame";
afterEach(() => { drainInjects(CHAT); });

function socket() {
  const sent: unknown[] = [];
  return { sent, ws: { send: (data: string) => { sent.push(JSON.parse(data)); } } };
}

describe("send_now", () => {
  it("moves the waiting command while the message is queued, and says so", () => {
    pushInject(CHAT, "are you stuck?", "inj-1");
    const hold = holdForSendNow(CHAT);
    const { sent, ws } = socket();

    handleSendNow(ws, CHAT, "inj-1");

    expect(hold.signal?.aborted).toBe(true);
    expect(sent).toEqual([{ type: "send_now_result", sessionId: CHAT, injectId: "inj-1", movedToBackground: 1 }]);
    hold.release();
  });

  it("moves nothing once the message was read, nor when no command is waiting", () => {
    const hold = holdForSendNow(CHAT);
    const { sent, ws } = socket();
    handleSendNow(ws, CHAT, "inj-2");
    expect(hold.signal?.aborted).toBe(false);
    hold.release();

    pushInject(CHAT, "still there?", "inj-3");
    handleSendNow(ws, CHAT, "inj-3");
    expect(sent).toEqual([
      { type: "send_now_result", sessionId: CHAT, injectId: "inj-2", movedToBackground: 0 },
      { type: "send_now_result", sessionId: CHAT, injectId: "inj-3", movedToBackground: 0 },
    ]);
  });
});

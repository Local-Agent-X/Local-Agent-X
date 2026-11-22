// @vitest-environment happy-dom
//
// "Send now" under a message typed while the agent works: the button sends the
// send_now frame for that message, and the server's answer says whether the
// agent reads it now (a waiting command moved to the background) or when its
// current step ends. Drives the real store and button scripts.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHAT = "chat-send-now-ui";

interface Block { type: string; injectId?: string; queueState?: string; sendNow?: string }
interface Store {
  startTurn(sessionId: string, anchorIdx?: number): unknown;
  addInject(sessionId: string, injectId: string, text: string): boolean;
  consumeInject(sessionId: string, injectId: string): boolean;
  get(sessionId: string): { blocks: Block[] } | undefined;
}
type Win = { ChatStreamStore: Store; sendNowButton(b: Block): HTMLButtonElement; handleSendNowResult(msg: unknown): void };

let store: Store;
let win: Win;
let sent: Array<Record<string, unknown>>;
let rerendered: string[];

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown> & { window: Win };
  for (const file of ["agentxos-timeline.js", "chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-send-now.js"]) {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(join(here, "../public/js", file), "utf8"))();
  }
  win = g.window;
  store = win.ChatStreamStore;
  g.ChatStreamStore = store;
  sent = [];
  rerendered = [];
  g.activeChat = { id: CHAT };
  g.chatWs = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  g.rerenderLiveMessage = (id: string) => rerendered.push(id);
  store.startTurn(CHAT, 0);
  store.addInject(CHAT, "inj-1", "are you stuck?");
});

const block = () => store.get(CHAT)!.blocks.find((b) => b.injectId === "inj-1")!;

describe("Send now", () => {
  it("sends the frame for that message and shows it is on its way", () => {
    const button = win.sendNowButton(block());
    expect(button.textContent).toBe("Send now");
    button.click();
    expect(sent).toEqual([{ type: "send_now", sessionId: CHAT, injectId: "inj-1" }]);
    const redrawn = win.sendNowButton(block());
    expect(redrawn.textContent).toBe("Sending…");
    expect(redrawn.disabled).toBe(true);
    expect(rerendered).toEqual([CHAT]);
  });

  it("says the agent is reading it when a command moved, or reads it after the step otherwise", () => {
    win.handleSendNowResult({ type: "send_now_result", sessionId: CHAT, injectId: "inj-1", movedToBackground: 1 });
    expect(win.sendNowButton(block()).textContent).toBe("Sent: the agent is reading it now");
    win.handleSendNowResult({ type: "send_now_result", sessionId: CHAT, injectId: "inj-1", movedToBackground: 0 });
    expect(win.sendNowButton(block()).textContent).toBe("The agent reads it when its current step ends");
  });

  it("leaves a message the agent already read alone", () => {
    store.consumeInject(CHAT, "inj-1");
    win.handleSendNowResult({ type: "send_now_result", sessionId: CHAT, injectId: "inj-1", movedToBackground: 1 });
    expect(block().sendNow).toBeUndefined();
    expect(rerendered).toEqual([]);
  });
});

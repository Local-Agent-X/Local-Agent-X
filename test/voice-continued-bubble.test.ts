// @vitest-environment happy-dom
//
// A voice message the user did not finish in one breath is one bubble. The
// server reads a short pause as the end of the message and starts a reply; if
// the user keeps talking it sends the new words as a `final` marked
// `continues` (voice-session/turn-runner.ts). public/js/chat-voice-ws-handler.js
// then adds those words to the bubble they carry on and removes the reply the
// pause started, on screen and in the chat's saved messages.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/chat-voice-ws-handler.js"), "utf8");

function sourceOf(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in chat-voice-ws-handler.js`);
  const end = SRC.indexOf("\n}", start);
  return SRC.slice(start, end + 2);
}

type Message = { role: string; content: string };
interface Page {
  voiceLastUserEl: Element | null;
  voiceCutReplyEl: Element | null;
  voiceCurrentMsgEl: Element | null;
  voicePartialEl: Element | null;
  voiceContinuing: { body: Element; base: string } | null;
  activeChat: { messages: Message[]; updatedAt: number } | null;
}

/** The two functions, run against a page's voice globals. */
interface Loaded {
  joinWords(messages: Message[], text: string): boolean;
  joinBubble(text: string): boolean;
  start(): void;
  show(text: string): boolean;
  stop(): void;
}
function load(page: Page): Loaded {
  const body = `with (page) {
    let voiceCurrentMsgBody = null, voiceCurrentMsgText = '';
    ${sourceOf("voiceJoinContinuedWords")}
    ${sourceOf("_voiceJoinContinuedBubble")}
    ${sourceOf("_voiceStartContinuing")}
    ${sourceOf("_voiceShowContinuedWords")}
    ${sourceOf("_voiceStopContinuing")}
    return { joinWords: voiceJoinContinuedWords, joinBubble: _voiceJoinContinuedBubble, start: _voiceStartContinuing, show: _voiceShowContinuedWords, stop: _voiceStopContinuing };
  }`;
  return new Function("page", body)(page);
}

function bubble(role: string, text: string): Element {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  const b = document.createElement("div");
  b.className = "msg-body";
  b.textContent = text;
  el.appendChild(b);
  document.body.appendChild(el);
  return el;
}

describe("a continued voice message", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("joins the new words to the saved message and drops the reply the pause started", () => {
    const { joinWords } = load({ voiceLastUserEl: null, voiceCutReplyEl: null, voiceCurrentMsgEl: null, voicePartialEl: null, voiceContinuing: null, activeChat: null });
    const heard: Message[] = [{ role: "user", content: "I run a store" }, { role: "assistant", content: "Sure" }];
    expect(joinWords(heard, "and need a reorder report")).toBe(true);
    expect(heard).toEqual([{ role: "user", content: "I run a store and need a reorder report" }]);

    const unheard: Message[] = [{ role: "assistant", content: "Hi" }, { role: "user", content: "I run a store" }];
    expect(joinWords(unheard, "and need a report")).toBe(true);
    expect(unheard[1].content).toBe("I run a store and need a report");
    expect(unheard).toHaveLength(2);
  });

  it("leaves a thread that does not end in the user's message alone", () => {
    const { joinWords } = load({ voiceLastUserEl: null, voiceCutReplyEl: null, voiceCurrentMsgEl: null, voicePartialEl: null, voiceContinuing: null, activeChat: null });
    const thread: Message[] = [{ role: "assistant", content: "one" }, { role: "assistant", content: "two" }];
    expect(joinWords(thread, "more")).toBe(false);
    expect(thread).toHaveLength(2);
    expect(joinWords([], "more")).toBe(false);
  });

  it("shows one bubble: the cut-off reply and the live preview are removed", () => {
    const user = bubble("user", "I run a store");
    const cut = bubble("assistant", "");
    const preview = bubble("user", "and need a");
    const page: Page = {
      voiceLastUserEl: user, voiceCutReplyEl: cut, voiceCurrentMsgEl: null, voicePartialEl: preview, voiceContinuing: null,
      activeChat: { messages: [{ role: "user", content: "I run a store" }], updatedAt: 0 },
    };
    expect(load(page).joinBubble("and need a reorder report")).toBe(true);
    expect(document.querySelectorAll(".msg")).toHaveLength(1);
    expect(user.querySelector(".msg-body")?.textContent).toBe("I run a store and need a reorder report");
    expect(page.voiceCutReplyEl).toBeNull();
    expect(page.voicePartialEl).toBeNull();
    expect(page.activeChat?.messages).toEqual([{ role: "user", content: "I run a store and need a reorder report" }]);
  });

  it("fills the same bubble while the user keeps talking: no second bubble at any point", () => {
    const user = bubble("user", "I run a store");
    const reply = bubble("assistant", "");
    const page: Page = {
      voiceLastUserEl: user, voiceCutReplyEl: null, voiceCurrentMsgEl: reply, voicePartialEl: null, voiceContinuing: null,
      activeChat: { messages: [{ role: "user", content: "I run a store" }], updatedAt: 0 },
    };
    const voice = load(page);
    const text = () => user.querySelector(".msg-body")?.textContent;

    voice.start(); // tts_interrupt marked `continues`
    expect(document.querySelectorAll(".msg")).toHaveLength(1);
    expect(voice.show("and need")).toBe(true);
    expect(text()).toBe("I run a store and need");
    expect(voice.show("and need a reorder")).toBe(true);
    expect(text()).toBe("I run a store and need a reorder");
    expect(document.querySelectorAll(".msg")).toHaveLength(1);

    expect(voice.joinBubble("and need a reorder report")).toBe(true); // the final
    expect(text()).toBe("I run a store and need a reorder report");
    expect(page.voiceContinuing).toBeNull();
    expect(voice.show("next")).toBe(false);
  });

  it("puts the message back when the sound was noise and no words came", () => {
    const user = bubble("user", "I run a store");
    const page: Page = { voiceLastUserEl: user, voiceCutReplyEl: null, voiceCurrentMsgEl: null, voicePartialEl: null, voiceContinuing: null, activeChat: null };
    const voice = load(page);
    voice.start();
    voice.show("uh");
    voice.show("");
    expect(user.querySelector(".msg-body")?.textContent).toBe("I run a store");
    voice.show("mm");
    voice.stop(); // the reply is made again (agent_start)
    expect(user.querySelector(".msg-body")?.textContent).toBe("I run a store");
    expect(voice.show("later")).toBe(false);
  });

  it("draws a new bubble when there is none to join", () => {
    const page: Page = { voiceLastUserEl: null, voiceCutReplyEl: null, voiceCurrentMsgEl: null, voicePartialEl: null, voiceContinuing: null, activeChat: null };
    expect(load(page).joinBubble("hello")).toBe(false);
  });
});

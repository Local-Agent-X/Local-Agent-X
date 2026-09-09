// @vitest-environment happy-dom
//
// Regression: a finished answer's footer held a timestamp and nothing else.
// Both footer controls — the 🔊 read-aloud button (chat-render.js) and the
// ↻ Regenerate / ✎ Edit & resend bar (chat-retract-actions.js, hung off
// _applyPinBottom) — were wired ONLY into the full-thread render. A completed
// turn doesn't take that path: chat-send-ws.js / chat-send-http.js call
// finalizeLiveMessageInPlace to avoid the whole-thread repaint flash, and that
// built a fresh bubble whose footer it overwrote with just the timestamp. The
// controls only reappeared on a chat switch or reload, so in normal use they
// looked deleted.
//
// The terminal paint now attaches both. Drives the REAL finalize through
// happy-dom — no copy of the DOM shape — so the two paint paths can't drift
// apart again silently.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type ToolEvent = { type: string; name: string; toolCallId: string; args?: Record<string, string>; status?: string; result?: string };
interface FinalizedMsg {
  role: string;
  content: string;
  timestamp: number;
  _tools?: ToolEvent[];
  _blocks?: unknown[];
  _localNote?: boolean;
}
interface Store { content: string; toolEvents: ToolEvent[] }

const g = globalThis as unknown as Record<string, unknown>;

let buildLive: (parent: HTMLElement, store: Partial<Store>) => HTMLElement;
let finalize: (sessionId: string, msg: FinalizedMsg) => boolean;
let speakBubbleCalls: Element[];

const load = <T>(file: string, ret: string): T => {
  const src = readFileSync(join(here, "../public/js/" + file), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${ret};`)() as T;
};

const SESSION = "s1";

beforeEach(() => {
  document.body.innerHTML = '<div id="messages"></div><textarea id="msg-input"></textarea>';
  document.head.innerHTML = "";
  speakBubbleCalls = [];

  // shared.js / chat.js globals the render modules resolve at call time.
  g.esc = (s: unknown) => String(s ?? "");
  g.md = (s: unknown) => String(s ?? "");
  g.mdPreviewMode = true;
  g.isContentIdle = () => false;
  g.thinkingHTML = () => '<div class="thinking">…</div>';
  g.renderTimelineBlocks = () => {};
  g.prependReasoningBlock = () => {};
  g.formatMsgTime = () => "10:42 PM";
  g.speakBubble = (_btn: Element, body: Element) => { speakBubbleCalls.push(body); };
  (g.window as Window).speechSynthesis = {} as SpeechSynthesis;

  // A completed turn: the prompt and its reply are already in messages[]
  // (promoteLiveToMessages spliced the reply in before finalize runs) and the
  // store's status is 'done', which is what un-gates the retract controls.
  g.activeChat = {
    id: SESSION,
    messages: [
      { role: "user", content: "compute 2+2" },
      { role: "assistant", content: "4" },
    ],
  };
  g.ChatStreamStore = { isStreaming: () => false };
  g.apiPost = vi.fn(async () => ({ ok: true, mode: "turn" }));
  g.saveChats = vi.fn();
  g.renderMessages = vi.fn();

  Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
  Object.assign(g, load<object>("chat-render-artifacts.js", "{ _buildLiveAssistantInto, _renderAssistantToolArtifacts }"));
  Object.assign(g, load<object>("chat-render-open-state.js", "{ preserveOpenState, captureActivityScroll, restoreActivityScroll }"));
  Object.assign(g, load<object>("chat-render.js", "{ appendReadAloudBtn, _applyPinBottom }"));
  load<void>("chat-retract-actions.js", "undefined"); // attaches appendLastTurnControls to window
  Object.assign(g, load<object>("chat-render-live.js", "{ finalizeLiveMessageInPlace }"));

  buildLive = g._buildLiveAssistantInto as typeof buildLive;
  finalize = g.finalizeLiveMessageInPlace as typeof finalize;
});

// Paint the in-flight bubble the way a streaming turn does, then run the
// terminal swap over it — the exact sequence _finalizeWsTurn produces.
function finishTurn(msg: Partial<FinalizedMsg> = {}, live: Partial<Store> = {}): HTMLElement {
  const el = document.getElementById("messages") as HTMLElement;
  buildLive(el, { content: "4", toolEvents: [], ...live });
  const finalized: FinalizedMsg = { role: "assistant", content: "4", timestamp: 1_759_000_000_000, ...msg };
  expect(finalize(SESSION, finalized)).toBe(true);
  return el.querySelector(".msg.assistant") as HTMLElement;
}

const footerOf = (node: HTMLElement) => node.querySelector(".msg-footer") as HTMLElement;

describe("terminal paint — footer controls survive the in-place finalize", () => {
  it("leaves the finished answer with read-aloud AND both last-turn controls", () => {
    const footer = footerOf(finishTurn());

    expect(footer.querySelector(".msg-time")!.textContent).toBe("10:42 PM");
    expect(footer.querySelectorAll(".read-aloud-btn")).toHaveLength(1);
    const bar = footer.querySelector(".last-turn-actions")!;
    expect(bar).not.toBeNull();
    expect([...bar.querySelectorAll("button.last-turn-btn")].map(b => b.textContent))
      .toEqual(["↻ Regenerate", "✎ Edit & resend"]);
  });

  it("wires read-aloud to the FINALIZED bubble's body, not the discarded live node", () => {
    const node = finishTurn();
    (footerOf(node).querySelector(".read-aloud-btn") as HTMLButtonElement).click();

    expect(speakBubbleCalls).toHaveLength(1);
    expect(speakBubbleCalls[0]).toBe(node.querySelector(".msg-body"));
    expect(document.contains(speakBubbleCalls[0])).toBe(true);
  });

  it("pins the finished bubble so it keeps its reserved room", () => {
    expect(finishTurn().classList.contains("pin-bottom")).toBe(true);
  });

  it("gives a tools-only turn the recovery controls but no read-aloud", () => {
    const tools: ToolEvent[] = [
      { type: "start", name: "bash", toolCallId: "c0", args: { command: "ls" } },
      { type: "end", name: "bash", toolCallId: "c0", status: "ok", result: "" },
    ];
    const footer = footerOf(finishTurn({ content: "", _tools: tools }, { content: "", toolEvents: tools }));

    expect(footer.querySelector(".read-aloud-btn")).toBeNull();
    expect(footer.querySelector(".last-turn-actions")).not.toBeNull();
  });

  it("does not stack duplicates when the full render repaints the same bubble", () => {
    const node = finishTurn();
    const msg = { role: "assistant", content: "4", timestamp: 1 };
    (g.appendReadAloudBtn as (n: HTMLElement, m: unknown) => void)(node, msg);
    (g._applyPinBottom as (el: HTMLElement) => void)(document.getElementById("messages") as HTMLElement);

    expect(footerOf(node).querySelectorAll(".read-aloud-btn")).toHaveLength(1);
    expect(footerOf(node).querySelectorAll(".last-turn-actions")).toHaveLength(1);
  });
});

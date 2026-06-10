// @vitest-environment happy-dom
//
// Phase 2 of the UI-freeze fix: entry renders of long threads paint only the
// tail window instead of every row. Covers the window-start decision (entry
// reset, preserved expansion, live-anchor clamp) and the earlier-history
// prepend (order, scroll-state bookkeeping, sentinel lifecycle). renderMessage
// is stubbed to its real contract — appends a row to #messages and returns it —
// which is exactly the coupling loadEarlierMessages relies on (append, then
// relocate above the first rendered row).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Chat = { messages: { role: string; content: string }[]; _renderWindowStart?: number };
type Api = {
  _resolveWindowStart: (chat: Chat, isEntry: boolean, anchor: number) => number;
  _appendEarlierSentinel: (el: HTMLElement, chat: Chat) => void;
  loadEarlierMessages: () => void;
};

let api: Api;
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  document.body.innerHTML = '<div id="messages"></div>';
  const src = readFileSync(join(here, "../public/js/chat-render-window.js"), "utf8");
  // eslint-disable-next-line no-new-func
  api = new Function(`${src}; return { _resolveWindowStart, _appendEarlierSentinel, loadEarlierMessages };`)();
  g.renderMessage = (msg: { content: string }) => {
    const el = document.getElementById("messages")!;
    const div = document.createElement("div");
    div.className = "msg";
    div.dataset.content = msg.content;
    el.appendChild(div);
    return div;
  };
  g._applyPinBottom = () => {};
});

const chatWith = (n: number): Chat => ({
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
});

describe("_resolveWindowStart", () => {
  it("entry render starts at the tail window", () => {
    const chat = chatWith(200);
    expect(api._resolveWindowStart(chat, true, -1)).toBe(120);
    expect(chat._renderWindowStart).toBe(120);
  });

  it("in-place rebuild preserves history the reader already expanded", () => {
    const chat = chatWith(200);
    chat._renderWindowStart = 40;
    expect(api._resolveWindowStart(chat, false, -1)).toBe(40);
  });

  it("always includes the live streaming anchor", () => {
    const chat = chatWith(200);
    expect(api._resolveWindowStart(chat, true, 10)).toBe(10);
  });

  it("clamps a stale start after messages were replaced with fewer", () => {
    const chat = chatWith(50);
    chat._renderWindowStart = 90;
    expect(api._resolveWindowStart(chat, false, -1)).toBe(50);
  });

  it("renders everything when the thread fits in one window", () => {
    const chat = chatWith(30);
    expect(api._resolveWindowStart(chat, true, -1)).toBe(0);
  });
});

describe("loadEarlierMessages", () => {
  function setup(total: number, windowStart: number) {
    const chat = chatWith(total);
    chat._renderWindowStart = windowStart;
    g.activeChat = chat;
    const el = document.getElementById("messages")!;
    api._appendEarlierSentinel(el, chat);
    for (let i = windowStart; i < total; i++) (g.renderMessage as (m: unknown) => void)(chat.messages[i]);
    return { chat, el };
  }

  it("prepends the previous chunk in order above the first rendered row", () => {
    const { chat, el } = setup(200, 120);
    api.loadEarlierMessages();
    expect(chat._renderWindowStart).toBe(40);
    const rows = [...el.querySelectorAll(".msg")].map((r) => (r as HTMLElement).dataset.content);
    expect(rows.length).toBe(160);
    expect(rows[0]).toBe("m40");
    expect(rows[79]).toBe("m119");
    expect(rows[80]).toBe("m120");
    expect(rows[159]).toBe("m199");
    expect(document.getElementById("earlier-sentinel")!.textContent).toContain("40 earlier");
  });

  it("removes the sentinel once the full history is rendered", () => {
    const { chat } = setup(100, 20);
    api.loadEarlierMessages();
    expect(chat._renderWindowStart).toBe(0);
    expect(document.getElementById("earlier-sentinel")).toBeNull();
  });
});

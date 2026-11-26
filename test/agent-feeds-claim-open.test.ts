// @vitest-environment happy-dom
//
// A row in the AGENTS tab's WORKING ON strip, or in the chat window's pill
// panel, opens that agent's work (2026-11-22). The rows used to be display
// only: a worker you could see working had nothing to click, while the same
// worker's row in the job list below opened its detail, so a click sometimes
// worked and sometimes did nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const sources = [
  "shared-escape.js", "chat-agent-feeds-render.js", "chat-agent-feeds-ambient.js", "chat-agent-feeds-jobs.js",
  "chat-agent-feeds-scope.js", "chat-agent-feeds.js", "chat-agent-feeds-claims.js", "chat-agent-feeds-claim-open.js",
].map(read);

type Rec = Record<string, unknown>;
interface Panel {
  addAgentFeed: (a: Rec) => void;
  reconcileAgentFeeds: (workers: Rec[]) => void;
  refreshWorkClaims: () => Promise<void>;
  toggleAgentsPanel: () => void;
  scope: () => string;
}

const CHATS = [{ id: "chat-a", title: "Label checker" }, { id: "chat-b", title: "Shop helper" }];
const selectChat = vi.fn();
const switchSidePanelTab = vi.fn();
const addNotification = vi.fn();
const sent: Rec[] = [];
let claims: Rec = { holders: [], mine: [], others: [] };
const apiFetch = async () => ({ ok: true, json: async () => claims });

// The listeners claim-open.js adds, kept per load so an earlier load's never fire.
let listeners: Array<[string, (e: unknown) => void, unknown]> = [];
const doc = new Proxy(document, {
  get(target, key) {
    if (key === "addEventListener") return (type: string, fn: (e: unknown) => void, opts: unknown) => listeners.push([type, fn, opts]);
    const v = Reflect.get(target, key);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

const PRELUDE = [
  "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = false;",
  "var Spring = { animate: function() {}, staggerIn: function() {} };",
  "function agentFeedsIsMobile() { return false; } function getAgentFeedsWidth() { return 300; }",
  "var activeChat = { id: 'chat-a' }; window.activeChat = activeChat;",
].join("\n");
const EXPORTS = "return { addAgentFeed, reconcileAgentFeeds, refreshWorkClaims, toggleAgentsPanel, scope: function() { return agentFeedsScope; } };";

function load(): Panel {
  listeners = [];
  document.body.innerHTML = '<div id="agent-feeds" class="collapsed"></div><span id="agent-count"></span><div id="agent-feeds-scope"></div>'
    + '<div id="work-claims"></div><span id="other-agents-strip"></span><div id="agents-clash"></div><div id="agent-feeds-list"></div>';
  const factory = new Function(
    "document", "ChatStreamStore", "renderSidebar", "chats", "apiFetch", "setInterval", "selectChat", "switchSidePanelTab", "addNotification",
    [PRELUDE, ...sources, EXPORTS].join("\n"),
  );
  return factory(doc, { setSidebarActive: () => {} }, () => {}, CHATS, apiFetch, () => 0, selectChat, switchSidePanelTab, addNotification) as Panel;
}

function click(el: Element): void {
  const capture = listeners.filter(([type, , opts]) => type === "click" && opts === true);
  for (const [, fn] of capture) fn({ target: el, stopPropagation: () => {} });
}

const row = (sessionId: string, kind: string, displayName: string, opId: string | null) =>
  ({ sessionId, opId, kind, displayName, task: "", state: "active", folder: "repo", areas: [], clashesWith: ["another agent"] });
const strip = (name: string) => [...document.querySelectorAll("#work-claims .work-claim-row")].find((el) => el.textContent?.includes(name))!;
const panelOpen = () => document.getElementById("agent-feeds")!.classList.contains("active");

beforeEach(() => {
  localStorage.clear();
  selectChat.mockClear(); switchSidePanelTab.mockClear(); addNotification.mockClear();
  sent.length = 0;
  (window as unknown as { sendChatWsControl: (p: Rec) => boolean }).sendChatWsControl = (p) => { sent.push(p); return true; };
});
afterEach(() => { vi.useRealTimers(); });

describe("a row in the WORKING ON strip opens that agent's work", () => {
  it("draws every row as something to click, for workers and chats alike", async () => {
    const p = load();
    claims = { holders: [], mine: [row("chat-a", "chat", "Label checker", null)], others: [row("w-1", "worker", "Skeptic", "op-skeptic")] };
    await p.refreshWorkClaims();
    const rows = [...document.querySelectorAll("#work-claims .work-claim-row")];
    expect(rows.map((el) => [el.getAttribute("role"), el.getAttribute("tabindex"), el.getAttribute("title")])).toEqual([
      ["button", "0", "Open this chat"], ["button", "0", "Show what this agent is doing"],
    ]);
    expect(rows[1].getAttribute("data-claim-op")).toBe("op-skeptic");
  });

  it("a worker opens its row's detail in the job list, widening This chat to All when the list hides it", async () => {
    const p = load();
    // The build was started from chat-b, so This chat (chat-a) hides its worker.
    p.addAgentFeed({ id: "op-build", name: "Build", type: "orchestrator", status: "working", chatId: "chat-b" });
    p.addAgentFeed({ id: "op-skeptic", name: "Skeptic: chunk 6", status: "working", parentOpId: "op-build" });
    expect(document.querySelector('[data-agent-row="op-skeptic"]')).toBeNull();
    claims = { holders: [], mine: [], others: [row("w-1", "worker", "Skeptic", "op-skeptic")] };
    await p.refreshWorkClaims();

    click(strip("Skeptic"));
    expect(p.scope()).toBe("all");
    expect(panelOpen()).toBe(true);
    expect(switchSidePanelTab).toHaveBeenCalledWith("agents");
    expect(document.querySelector('[data-agent-row="op-skeptic"]')!.classList.contains("open")).toBe(true);
    expect(selectChat).not.toHaveBeenCalled();
  });

  it("keeps This chat when the worker is already listed there", async () => {
    const p = load();
    p.addAgentFeed({ id: "op-mine", name: "Mine", status: "working", chatId: "chat-a" });
    claims = { holders: [], mine: [row("w-2", "worker", "Mine", "op-mine")], others: [] };
    await p.refreshWorkClaims();
    click(strip("Mine"));
    expect(p.scope()).toBe("chat");
    expect(document.querySelector('[data-agent-row="op-mine"]')!.classList.contains("open")).toBe(true);
  });

  it("a chat opens that chat", async () => {
    const p = load();
    claims = { holders: [], mine: [], others: [row("chat-b", "chat", "Shop helper", null)] };
    await p.refreshWorkClaims();
    click(strip("Shop helper"));
    expect(selectChat).toHaveBeenCalledWith("chat-b");
  });

  it("a worker this window never heard of is asked for, then opened when the snapshot lands", async () => {
    vi.useFakeTimers();
    const p = load();
    claims = { holders: [], mine: [], others: [row("w-3", "worker", "Late", "op-late")] };
    await p.refreshWorkClaims();
    click(strip("Late"));
    expect(sent).toEqual([{ type: "workers_list" }]);
    p.reconcileAgentFeeds([{ opId: "op-late", sessionId: "w-3", task: "Late worker", status: "running" }]);
    vi.advanceTimersByTime(1500);
    expect(document.querySelector('[data-agent-row="op-late"]')!.classList.contains("open")).toBe(true);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to open, instead of swallowing the click", async () => {
    vi.useFakeTimers();
    const p = load();
    claims = { holders: [], mine: [], others: [row("w-4", "worker", "Ghost", "op-ghost"), row("x-1", "chat", "Elsewhere", null)] };
    await p.refreshWorkClaims();
    click(strip("Ghost"));
    vi.advanceTimersByTime(1500);
    click(strip("Elsewhere"));
    expect(addNotification.mock.calls.map((c) => c[0])).toEqual([
      "Nothing to open for Ghost: this window has no record of its work.",
      "Nothing to open for Elsewhere: this window has no record of its work.",
    ]);
  });
});

describe("a row in the chat window's pill panel", () => {
  it("opens the same way and closes the panel behind it", async () => {
    const p = load();
    claims = { holders: [], mine: [], others: [row("chat-b", "chat", "Shop helper", null)] };
    await p.refreshWorkClaims();
    p.toggleAgentsPanel();
    const agent = document.querySelector("#other-agents-strip .other-agent")!;
    expect(agent.getAttribute("role")).toBe("button");
    click(agent);
    expect(selectChat).toHaveBeenCalledWith("chat-b");
    expect(document.querySelector("#other-agents-strip .agents-panel")).toBeNull();
  });
});

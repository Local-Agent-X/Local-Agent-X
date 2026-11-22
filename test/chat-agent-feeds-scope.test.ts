// @vitest-environment happy-dom
//
// The AGENTS tab shows the chat on screen (2026-11-22). Every chat's agents
// used to sit in one list, and any chat's agent could open the panel over the
// chat being read. Now a card belongs to the chat its job was started from,
// the list and the tab's count are that chat's, a switch widens it to all
// chats, and a chat that is not on screen marks its sidebar row instead of
// opening the panel.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const sources = [
  "shared-escape.js", "chat-agent-feeds-render.js", "chat-agent-feeds-ambient.js", "chat-agent-feeds-jobs.js",
  "chat-agent-feeds-scope.js", "chat-agent-feeds.js", "chat-agent-feeds-sync.js",
].map(read);

type Rec = Record<string, unknown>;
interface Panel {
  addAgentFeed: (a: Rec) => void;
  updateAgentFeed: (id: string, u: Rec) => void;
  reconcileAgentFeeds: (workers: Rec[]) => void;
  clearFinishedAgentFeeds: () => void;
  setAgentFeedsScope: (scope: string) => void;
  setChat: (id: string | null) => void;
  setAutoOpen: (on: boolean) => void;
  data: () => Record<string, Rec>;
  feedChatOf: (rec: Rec, map: Record<string, Rec>) => string;
}

const CHATS = [{ id: "chat-a", title: "Label checker" }, { id: "chat-b", title: "Shop helper" }];
const sidebarActive = vi.fn();
const refreshWorkClaims = vi.fn();

// What opening the panel needs from the files this test leaves out.
const PRELUDE = [
  "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = true; var setInterval = function() {};",
  "var Spring = { animate: function() {}, staggerIn: function() {} };",
  "function agentFeedsIsMobile() { return false; } function getAgentFeedsWidth() { return 300; }",
  "var activeChat = startChat ? { id: startChat } : null;",
].join("\n");
const EXPORTS = [
  "return { addAgentFeed, updateAgentFeed, reconcileAgentFeeds, clearFinishedAgentFeeds, setAgentFeedsScope, feedChatOf,",
  "  setChat: function(id) { activeChat = id ? { id: id } : null; window.laxAgentFeedsScope.onChatChanged(); },",
  "  setAutoOpen: function(on) { agentFeedsAutoOpen = on; },",
  "  data: function() { return agentFeedsData; } };",
].join("\n");

function load(activeId: string | null = "chat-a"): Panel {
  document.body.innerHTML = '<div id="agent-feeds" class="collapsed"></div><span id="agent-count"></span><div id="agent-feeds-scope"></div><div id="agent-feeds-list"></div>';
  const factory = new Function(
    "document", "ChatStreamStore", "renderSidebar", "refreshWorkClaims", "chats", "startChat",
    [PRELUDE, ...sources, EXPORTS].join("\n"),
  );
  return factory(document, { setSidebarActive: sidebarActive }, () => {}, refreshWorkClaims, CHATS, activeId) as Panel;
}

const listed = (): string[] => Array.from(document.querySelectorAll("[data-agent-row]")).map((el) => el.getAttribute("data-agent-row")!).sort();
const count = (): string => document.getElementById("agent-count")!.textContent ?? "";
const panelOpen = (): boolean => document.getElementById("agent-feeds")!.classList.contains("active");

/** Chat A runs a build with one worker; chat B runs one agent; a dream belongs to no chat. */
function seed(p: Panel): void {
  p.addAgentFeed({ id: "op-build", name: "Build", type: "orchestrator", status: "working", chatId: "chat-a" });
  // The worker's own frame names the build's session, not the chat: its lineage decides.
  p.addAgentFeed({ id: "agent-chunk-1", name: "Chunk 1", status: "working", parentOpId: "op-build", chatId: "op-build-session" });
  p.addAgentFeed({ id: "agent-b", name: "Research", status: "working", chatId: "chat-b" });
  p.addAgentFeed({ id: "op-dream", name: "Dream", type: "memory_consolidation", status: "working", chatId: "dream-2026-11-22" });
}

beforeEach(() => {
  localStorage.clear();
  sidebarActive.mockClear(); refreshWorkClaims.mockClear();
});

describe("the list is the chat on screen's", () => {
  it("shows that chat's jobs with their workers, and work that belongs to no chat", () => {
    const p = load("chat-a");
    seed(p);
    expect(listed()).toEqual(["agent-chunk-1", "op-build", "op-dream"]);
    expect(count()).toBe("3");
  });

  it("turns to the other chat's when that chat comes on screen", () => {
    const p = load("chat-a");
    seed(p);
    p.setChat("chat-b");
    expect(listed()).toEqual(["agent-b", "op-dream"]);
    expect(count()).toBe("2");
    expect(refreshWorkClaims).toHaveBeenCalledTimes(1); // the strip asks for that chat's rows
  });

  it("keeps every record: nothing is dropped by a view that hides it", () => {
    const p = load("chat-a");
    seed(p);
    expect(Object.keys(p.data()).sort()).toEqual(["agent-b", "agent-chunk-1", "op-build", "op-dream"]);
  });

  it("a worker belongs to the chat at the top of its lineage, and a cycle ends the walk", () => {
    const p = load();
    const map = { a: { id: "a", parentOpId: "b", chatId: "s-a" }, b: { id: "b", parentOpId: "a", chatId: "chat-b" } };
    expect(p.feedChatOf(map.a, map)).toBe("chat-b");
    expect(p.feedChatOf({ id: "lone" }, {})).toBe("");
  });

  it("a live worker the server lists after a reconnect lands in its chat", () => {
    const p = load("chat-a");
    p.reconcileAgentFeeds([{ opId: "op-x", sessionId: "chat-b", task: "Other chat's job", status: "running" }]);
    expect(listed()).toEqual([]);
    p.setChat("chat-b");
    expect(listed()).toEqual(["op-x"]);
  });

  it("with no chat open, lists everything", () => {
    const p = load(null);
    seed(p);
    expect(listed()).toEqual(["agent-b", "agent-chunk-1", "op-build", "op-dream"]);
  });
});

describe("the This chat / All chats switch", () => {
  it("draws both choices, This chat chosen by default", () => {
    load();
    const btns = Array.from(document.querySelectorAll("#agent-feeds-scope button"));
    expect(btns.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([["This chat", "true"], ["All chats", "false"]]);
  });

  it("All lists every chat's work under its chat's name, and is remembered", () => {
    const p = load("chat-a");
    seed(p);
    p.setAgentFeedsScope("all");
    expect(listed()).toEqual(["agent-b", "agent-chunk-1", "op-build", "op-dream"]);
    expect(count()).toBe("4");
    expect(Array.from(document.querySelectorAll(".job-chat")).map((el) => el.textContent)).toEqual(["Label checker", "Shop helper"]);
    expect(localStorage.getItem("lax_agent_feeds_scope")).toBe("all");
    // A fresh page opens on the remembered choice.
    load("chat-a");
    expect(document.querySelector('#agent-feeds-scope button[aria-pressed="true"]')?.textContent).toBe("All chats");
  });

  it("names no chat on the cards while it shows only this chat's", () => {
    const p = load("chat-a");
    seed(p);
    expect(document.querySelectorAll(".job-chat")).toHaveLength(0);
  });
});

describe("a chat that is not on screen never opens the panel", () => {
  it("its new agent marks its sidebar row instead", () => {
    const p = load("chat-a");
    p.addAgentFeed({ id: "agent-b", name: "Research", status: "working", chatId: "chat-b" });
    expect(panelOpen()).toBe(false);
    expect(sidebarActive).toHaveBeenCalledWith("chat-b", true);
    // A later frame for the same card marks nothing again.
    p.addAgentFeed({ id: "agent-b", status: "working", chatId: "chat-b" });
    expect(sidebarActive).toHaveBeenCalledTimes(1);
  });

  it("the chat on screen's agent opens it", () => {
    const p = load("chat-a");
    p.addAgentFeed({ id: "agent-a", name: "Mine", status: "working", chatId: "chat-a" });
    expect(panelOpen()).toBe(true);
    expect(sidebarActive).not.toHaveBeenCalled();
  });

  it("so does work that belongs to no chat, as before", () => {
    const p = load("chat-a");
    p.addAgentFeed({ id: "op-dream", name: "Dream", type: "memory_consolidation", status: "working", chatId: "dream-1" });
    expect(panelOpen()).toBe(true);
    expect(sidebarActive).not.toHaveBeenCalled();
  });

  it("AUTO off opens nothing", () => {
    const p = load("chat-a");
    p.setAutoOpen(false);
    p.addAgentFeed({ id: "agent-a", name: "Mine", status: "working", chatId: "chat-a" });
    expect(panelOpen()).toBe(false);
  });
});

describe("clearing the Finished drawer", () => {
  it("clears what the drawer shows, not another chat's finished work", () => {
    const p = load("chat-a");
    p.addAgentFeed({ id: "done-a", name: "Mine", status: "completed", chatId: "chat-a" });
    p.addAgentFeed({ id: "done-b", name: "Theirs", status: "completed", chatId: "chat-b" });
    p.clearFinishedAgentFeeds();
    expect(Object.keys(p.data())).toEqual(["done-b"]);
  });
});

// @vitest-environment happy-dom
//
// Tiled chats (ADR 0007 §6): two to eight chats side by side on the chat page.
// The chat on screen stays the one full chat (#chat-main); the others are live
// views that follow their chat's events and saved messages. Clicking a view
// opens that chat in its pane's place.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");
const coreJs = read("public/js/chat-tiles-core.js");
const viewJs = read("public/js/chat-tiles-view.js");
const tilesJs = read("public/js/chat-tiles.js");

type Chat = { id: string; title: string; projectId?: string; mode?: string; updatedAt?: number; archived?: boolean; messages: Array<Record<string, unknown>>; _needsHydrate?: boolean };
type Entry = { status: string; content: string; toolEvents: unknown[]; approvals: unknown[]; liveAnchorIndex: number };
type Core = {
  MAX_TILES: number;
  gridShape: (n: number) => { cols: number; rows: number };
  withChat: (ids: string[], focused: string, id: string | null) => string[];
  added: (ids: string[], id: string) => string[];
  pruned: (ids: string[], chats: Chat[]) => string[];
  projectChats: (chats: Chat[], active: Chat | null) => string[];
  tileState: (e: Partial<Entry> | null) => string;
  viewRows: (chat: Chat | null, e: Partial<Entry> | null, limit: number, keep: boolean) => Array<{ role: string; text: string; live: boolean; tool: string }>;
};
type Tiles = {
  toggle: () => void; onChatChanged: () => void; onSocketOpen: () => void; closeFocused: () => void;
  openAddMenu: () => void; isOn: () => boolean; tiles: () => string[]; showGroup: () => void;
};

const core: Core = new Function(`${coreJs}\nreturn ChatTilesCore;`)();
// A code session (mode "code"): the only kind the grid holds.
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({ id, title: `Title ${id}`, projectId: "p1", mode: "code", updatedAt: 1, messages: [], ...over });
const entry = (over: Partial<Entry> = {}): Entry => ({ status: "idle", content: "", toolEvents: [], approvals: [], liveAnchorIndex: -1, ...over });

describe("the rules of the tile grid", () => {
  it("lays out two side by side, then 2x2, 3x2 and 4x2", () => {
    expect([2, 3, 4, 5, 6, 7, 8].map((n) => core.gridShape(n))).toEqual([
      { cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 },
      { cols: 3, rows: 2 }, { cols: 4, rows: 2 }, { cols: 4, rows: 2 },
    ]);
  });

  it("keeps a tiled chat in its place and puts any other chat where the one on screen was", () => {
    expect(core.withChat(["a", "b", "c"], "a", "c")).toEqual(["a", "b", "c"]);
    expect(core.withChat(["a", "b", "c"], "b", "z")).toEqual(["a", "z", "c"]);
    expect(core.withChat(["a", "b"], "", "z")).toEqual(["a", "b", "z"]);
    expect(core.withChat(["a", "b"], "a", null)).toEqual(["a", "b"]);
  });

  it("holds at most eight, and drops a chat that was deleted or archived", () => {
    const eight = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(core.MAX_TILES).toBe(8);
    expect(core.added(eight, "9")).toEqual(eight);
    expect(core.added(["1"], "2")).toEqual(["1", "2"]);
    expect(core.pruned(["a", "gone", "b", "a", "old"], [chat("a"), chat("b"), chat("old", { archived: true })])).toEqual(["a", "b"]);
  });

  it("fills from the project of the chat on screen, that chat first, then the most recently used", () => {
    const chats = [chat("a", { updatedAt: 1 }), chat("b", { updatedAt: 5 }), chat("c", { updatedAt: 3 }),
      chat("other", { projectId: "p2", updatedAt: 9 }), chat("arch", { archived: true, updatedAt: 8 })];
    expect(core.projectChats(chats, chats[0])).toEqual(["a", "b", "c"]);
    expect(core.projectChats(chats, chat("solo", { projectId: undefined }))).toEqual(["solo"]);
    const many = Array.from({ length: 12 }, (_, i) => chat(`m${i}`, { updatedAt: i }));
    expect(core.projectChats(many, many[0])).toHaveLength(8);
  });

  it("says a pane needs the user while an approval waits, and is working while a turn runs", () => {
    expect(core.tileState(null)).toBe("idle");
    expect(core.tileState(entry({ status: "streaming" }))).toBe("working");
    expect(core.tileState(entry({ status: "streaming", approvals: [{ id: "x", status: "pending" }] }))).toBe("needs-you");
    expect(core.tileState(entry({ status: "streaming", approvals: [{ id: "x", status: "approved" }] }))).toBe("working");
  });

  it("shows the recent saved messages, then the reply being written with the tool it is in", () => {
    const c = chat("a", { messages: [
      { role: "user", content: "one" }, { role: "assistant", content: "", _tools: [{}, {}] },
      { role: "system", content: "hidden" }, { role: "user", content: "three" },
    ] });
    expect(core.viewRows(c, null, 2, false).map((r) => r.text)).toEqual(["Used 2 tools", "three"]);
    const live = entry({ status: "streaming", content: "Working on it", toolEvents: [
      { type: "start", name: "read", toolCallId: "1" }, { type: "end", name: "read", toolCallId: "1" },
      { type: "start", name: "shell", toolCallId: "2" },
    ] });
    expect(core.viewRows(c, live, 20, false).at(-1)).toEqual({ role: "assistant", text: "Working on it", live: true, tool: "shell" });
    const done = entry({ status: "done", content: "The answer" });
    expect(core.viewRows(c, done, 20, false).some((r) => r.live)).toBe(false);
    expect(core.viewRows(c, done, 20, true).at(-1)).toMatchObject({ text: "The answer", live: true, tool: "" });
  });
});

describe("the tile grid on the chat page", () => {
  let chats: Chat[];
  let entries: Record<string, Entry>;
  let storeCb: (id: string, e: Entry | null) => void;
  let tiles: Tiles;
  const sent: Array<{ type: string; sessionId: string }> = [];
  const selectChat = vi.fn((id: string) => {
    (window as { activeChat?: unknown }).activeChat = chats.find((c) => c.id === id) ?? null;
    tiles.onChatChanged();
  });
  let hydrated: string[];
  let finishHydrate: Array<() => void>;
  const hydrateChat = vi.fn((c: Chat) => { hydrated.push(c.id); return new Promise<void>((done) => { finishHydrate.push(done); }); });
  const apiFetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ current: { provider: "anthropic", model: `model-of-${url.split("=")[1]}` } }) }));
  const store = {
    get: (id: string) => entries[id] ?? null,
    isStreaming: (id: string) => entries[id]?.status === "streaming",
    isActive: (id: string) => entries[id]?.status === "streaming",
    subscribeAll: (cb: typeof storeCb) => { storeCb = cb; },
  };
  const tile = (id: string) => document.querySelector<HTMLElement>(`.chat-tile[data-session="${id}"]`)!;
  const main = () => document.getElementById("chat-main")!;
  const emit = (id: string, e: Entry) => { entries[id] = e; storeCb(id, e); };
  const toggleBtn = () => document.getElementById("chat-tiles-toggle")!;
  // sidebar-mode.js's rule, and the page's wait for the first chat to open.
  const chatModeOf = (c: Chat | null) => (c && (c.mode === "code" || c.id.startsWith("ide-")) ? "code" : "chat");
  let firstChatOpened: () => void;
  const load = () => new Function("chats", "selectChat", "newChat", "hydrateChat", "ChatStreamStore", "apiFetch", "WebSocket", "requestAnimationFrame", "chatModeOf", "setInterval", "clearInterval",
    `${coreJs}\n${viewJs}\n${tilesJs}\nreturn laxChatTiles;`)(chats, selectChat, newChat, hydrateChat, store, apiFetch, { OPEN: 1 }, (fn: () => void) => fn(), chatModeOf,
    (fn: () => void) => { firstChatOpened = fn; return 1; }, () => {});
  const newChat = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    document.body.className = "";
    document.body.innerHTML = `<button id="chat-tiles-add" style="display:none"></button><button id="chat-tiles-toggle" style="display:none"></button>
      <div id="chat-tiles"><div id="chat-main"><div id="chat-tile-head"><span class="chat-tile-title"></span><span class="chat-tile-orch"></span>
      <span class="chat-tile-clash"></span><span class="chat-tile-state"></span><span class="chat-tile-model"></span></div></div></div>`;
    chats = [chat("a", { updatedAt: 9 }), chat("b", { updatedAt: 5, messages: [{ role: "user", content: "hello b" }] }), chat("c", { updatedAt: 3 }), chat("z", { projectId: "p2" }),
      chat("plain", { mode: undefined, updatedAt: 8 })];
    entries = {};
    hydrated = [];
    finishHydrate = [];
    sent.length = 0;
    selectChat.mockClear(); hydrateChat.mockClear(); apiFetch.mockClear(); newChat.mockClear();
    (window as { activeChat?: unknown }).activeChat = chats[0];
    (window as { chatWs?: unknown }).chatWs = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    tiles = load();
    firstChatOpened();
  });

  it("offers tiles on a code session only, and holds code sessions only", () => {
    expect(toggleBtn().style.display).toBe("");
    selectChat("plain");
    expect(toggleBtn().style.display).toBe("none");
    tiles.toggle();
    expect(tiles.isOn()).toBe(false);
    expect(document.body.classList.contains("chat-tiles-on")).toBe(false);

    selectChat("a");
    tiles.toggle();
    expect(tiles.tiles()).toEqual(["a", "b", "c"]);
    tiles.openAddMenu();
    const offered = [...document.querySelectorAll(".chat-tiles-menu-item")].map((b) => b.textContent);
    expect(offered).toEqual(["All sessions in this project", "New session", "Title z"]);
    (document.querySelectorAll<HTMLElement>(".chat-tiles-menu-item")[1]).click();
    expect(newChat).toHaveBeenCalledWith("p1", "code");
  });

  it("puts the grid away on an ordinary chat and brings it back, as it was, on the next code session", () => {
    tiles.toggle();
    tile("b").click();
    selectChat("plain");
    expect(document.body.classList.contains("chat-tiles-on")).toBe(false);
    expect(document.querySelectorAll(".chat-tile")).toHaveLength(0);
    expect(main().style.order).toBe("");
    expect(tiles.isOn()).toBe(true);
    expect(JSON.parse(localStorage.getItem("lax_chat_tiles_v1")!).byProject).toEqual({ p1: ["a", "b", "c"] });

    selectChat("c");
    expect(document.body.classList.contains("chat-tiles-on")).toBe(true);
    expect(tiles.tiles()).toEqual(["a", "b", "c"]);
    expect(main().style.order).toBe("2");
  });

  it("comes back after a reload once a code session is on screen", () => {
    tiles.toggle();
    tile("c").querySelector<HTMLElement>(".chat-tile-close")!.click();
    document.querySelectorAll(".chat-tile").forEach((el) => el.remove());
    document.body.className = "";
    (window as { activeChat?: unknown }).activeChat = chats[4];
    tiles = load();
    firstChatOpened();
    expect(document.body.classList.contains("chat-tiles-on")).toBe(false);
    expect(toggleBtn().style.display).toBe("none");
    selectChat("b");
    expect(document.body.classList.contains("chat-tiles-on")).toBe(true);
    expect(tiles.tiles()).toEqual(["a", "b"]);
  });

  it("tiles a collab's chats together, and goes back to the code sessions' panes on a code session", () => {
    const group = { id: "collab-1", chatIds: ["host", "m1", "m2"] };
    chats.push(chat("host", { mode: undefined, projectId: undefined }), chat("m1", { mode: undefined, projectId: undefined }), chat("m2", { mode: undefined, projectId: undefined }));
    (window as { laxCollab?: unknown }).laxCollab = { of: (id: string) => (group.chatIds.includes(id) ? group : null) };
    try {
      tiles.toggle();
      expect(tiles.tiles()).toEqual(["a", "b", "c"]);

      selectChat("host");
      expect(toggleBtn().style.display).toBe("");
      expect(tiles.tiles()).toEqual(["host", "m1", "m2"]);
      expect(document.body.classList.contains("chat-tiles-on")).toBe(true);
      // A collab's panes are its chats: nothing to add.
      expect(document.getElementById("chat-tiles-add")!.style.display).toBe("none");
      tile("m2").click();
      expect(tiles.tiles()).toEqual(["host", "m1", "m2"]);

      selectChat("plain");
      expect(document.body.classList.contains("chat-tiles-on")).toBe(false);
      selectChat("b");
      expect(tiles.tiles()).toEqual(["a", "b", "c"]);
    } finally {
      delete (window as { laxCollab?: unknown }).laxCollab;
    }
  });

  it("opens the grid on a collab that just started, from a chat with tiles off", () => {
    const group = { id: "collab-2", chatIds: ["plain", "m1"] };
    chats.push(chat("m1", { mode: undefined, projectId: undefined }));
    (window as { laxCollab?: unknown }).laxCollab = { of: (id: string) => (group.chatIds.includes(id) ? group : null) };
    try {
      selectChat("plain");
      tiles.showGroup();
      expect(tiles.isOn()).toBe(true);
      expect(tiles.tiles()).toEqual(["plain", "m1"]);
    } finally {
      delete (window as { laxCollab?: unknown }).laxCollab;
    }
  });

  it("turns the page into a grid of the project's chats, the one on screen in its own pane", () => {
    tiles.toggle();
    expect(document.body.classList.contains("chat-tiles-on")).toBe(true);
    expect(tiles.tiles()).toEqual(["a", "b", "c"]);
    expect(document.getElementById("chat-tiles")!.style.getPropertyValue("--tile-cols")).toBe("2");
    expect(tile("a").hidden).toBe(true);
    expect(main().style.order).toBe("0");
    expect(tile("b").hidden).toBe(false);
    expect(tile("b").style.order).toBe("1");
    expect(tile("b").querySelector(".chat-tile-title")!.textContent).toBe("Title b");
    expect(tile("b").querySelector(".chat-tile-body")!.textContent).toContain("hello b");
    expect(sent.map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"]);
    expect(document.getElementById("chat-tile-head")!.querySelector(".chat-tile-title")!.textContent).toBe("Title a");
  });

  it("opens a clicked pane's chat in that pane's place", () => {
    tiles.toggle();
    tile("c").click();
    expect(selectChat).toHaveBeenCalledWith("c");
    expect(main().style.order).toBe("2");
    expect(tile("c").hidden).toBe(true);
    expect(tile("a").hidden).toBe(false);
    expect(tiles.tiles()).toEqual(["a", "b", "c"]);
  });

  it("puts a chat opened from the sidebar where the chat on screen was", () => {
    tiles.toggle();
    selectChat("z");
    expect(tiles.tiles()).toEqual(["z", "b", "c"]);
    expect(main().style.order).toBe("0");
    expect(document.querySelector('.chat-tile[data-session="a"]')).toBeNull();
  });

  it("reads back a turn another window started, and holds its reply on screen until it is saved", async () => {
    tiles.toggle();
    hydrated.length = 0;
    emit("b", entry({ status: "streaming", content: "Thinking it through" }));
    expect(hydrated).toEqual(["b"]);
    const live = tile("b").querySelector(".chat-tile-row.live")!;
    expect(live.textContent).toContain("Thinking it through");
    expect(tile("b").className).toContain("working");

    emit("b", entry({ status: "done", content: "Here is the answer" }));
    expect(hydrated).toEqual(["b", "b"]);
    expect(tile("b").querySelector(".chat-tile-row.live")!.textContent).toContain("Here is the answer");
    chats[1].messages.push({ role: "assistant", content: "Here is the answer" });
    finishHydrate.forEach((done) => done());
    await new Promise((r) => setTimeout(r, 0));
    expect(tile("b").querySelector(".chat-tile-row.live")).toBeNull();
    expect(tile("b").querySelector(".chat-tile-body")!.textContent).toContain("Here is the answer");
  });

  it("leaves a turn this page sent to save itself", () => {
    tiles.toggle();
    hydrated.length = 0;
    emit("b", entry({ status: "streaming", content: "x", liveAnchorIndex: 1 }));
    expect(hydrated).toEqual([]);
  });

  it("flags a pane whose chat is waiting on an approval", () => {
    tiles.toggle();
    emit("c", entry({ status: "streaming", approvals: [{ id: "ap1", status: "pending" }] }));
    expect(tile("c").className).toContain("needs-you");
    expect(tile("c").querySelector(".chat-tile-state")!.textContent).toBe("Needs you");
  });

  it("closes a pane without touching the chat, and leaves the grid when the last one closes", () => {
    tiles.toggle();
    tile("b").querySelector<HTMLElement>(".chat-tile-close")!.click();
    expect(tiles.tiles()).toEqual(["a", "c"]);
    expect(selectChat).not.toHaveBeenCalled();
    tiles.closeFocused();
    expect(selectChat).toHaveBeenCalledWith("c");
    tiles.closeFocused();
    expect(tiles.isOn()).toBe(false);
    expect(document.body.classList.contains("chat-tiles-on")).toBe(false);
    expect(document.querySelectorAll(".chat-tile")).toHaveLength(0);
    expect(main().style.order).toBe("");
  });

  it("follows every tiled chat again when the socket reconnects", () => {
    tiles.toggle();
    sent.length = 0;
    tiles.onSocketOpen();
    expect(sent).toEqual(["a", "b", "c"].map((sessionId) => ({ type: "subscribe", sessionId })));
  });

  it("remembers a project's tiles, and shows each pane's own model", async () => {
    tiles.toggle();
    tile("c").querySelector<HTMLElement>(".chat-tile-close")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(tile("b").querySelector(".chat-tile-model")!.textContent).toBe("model-of-b");
    tiles.toggle();
    expect(JSON.parse(localStorage.getItem("lax_chat_tiles_v1")!)).toMatchObject({ on: false, byProject: { p1: ["a", "b"] } });
    tiles.toggle();
    expect(tiles.tiles()).toEqual(["a", "b"]);
  });
});

describe("how the page is wired for tiles", () => {
  const html = read("public/app.html");
  it("wraps the chat in the grid and loads the rules before the grid", () => {
    expect(html).toMatch(/<div id="chat-tiles">\s*<div id="chat-main">/);
    const at = (name: string) => html.indexOf(`/js/${name}.js`);
    expect(at("chat-tiles-core")).toBeGreaterThan(0);
    expect(at("chat-tiles-core")).toBeLessThan(at("chat-tiles-view"));
    expect(at("chat-tiles-view")).toBeLessThan(at("chat-tiles"));
  });

  it("tells the grid whenever the chat on screen changes or the socket reconnects", () => {
    const actions = read("public/js/app-sidebar-actions.js");
    for (const fn of ["selectChat", "newChat", "deleteChat"]) {
      const body = actions.slice(actions.indexOf(`function ${fn}(`));
      expect(body.slice(0, body.indexOf("\n}\n"))).toContain("laxChatTiles.onChatChanged()");
    }
    expect(read("public/js/chat-ws.js")).toContain("laxChatTiles.onSocketOpen()");
  });
});

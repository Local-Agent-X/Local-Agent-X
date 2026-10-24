// The right panel's Preview tab (public/js/preview-tab.js): the panel's tab
// belongs to each chat. Switching chats turns an open panel to the tab that
// chat last had, a code session that never chose one opens on Preview, and a
// chat on the panel's own default (Agents), so a chat never shows another
// chat's app.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/preview-tab.js"), "utf8");

type Tab = { onTabShown(): void; onChatChanged(): void; rememberTab(t: string): void; openingTab(): string | null };
type Chat = { id: string; mode?: string; title?: string };

function load(chat: Chat | null, opts: { panelOpen?: boolean } = {}) {
  const store = new Map<string, string>();
  const switched: string[] = [];
  const elements = new Map<string, { style: { display?: string }; src?: string; textContent?: string }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { style: {} });
    return elements.get(id)!;
  };
  // The page globals the script reads, live: `with` lets a test change the chat.
  const page = {
    window: {} as { laxPreviewTab?: Tab },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    document: { getElementById: element },
    loadAppPreview: (frame: { src?: string }, appId: string) => { frame.src = `/apps/${appId}/index.html`; },
    activeChat: chat,
    agentFeedsOpen: !!opts.panelOpen,
    sidePanelTab: "agents",
    chatModeOf: (c: Chat | null) => (c && (c.mode === "code" || c.id.startsWith("ide-")) ? "code" : "chat"),
    switchSidePanelTab(t: string) {
      page.sidePanelTab = t;
      switched.push(t);
      element("preview-tab-body").style.display = t === "preview" ? "" : "none";
      page.window.laxPreviewTab!.rememberTab(t);
      if (t === "preview") page.window.laxPreviewTab!.onTabShown();
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("page", `with (page) {\n${src}\n}`)(page);
  return { tab: page.window.laxPreviewTab!, store, switched, page, frame: element("preview-tab-frame") };
}

describe("preview-tab.js — which tab the panel opens on", () => {
  it("a code session opens on Preview, a chat on the panel's default", () => {
    expect(load({ id: "ide-todo" }).tab.openingTab()).toBe("preview");
    expect(load({ id: "chat-1", mode: "code" }).tab.openingTab()).toBe("preview");
    expect(load({ id: "chat-1" }).tab.openingTab()).toBe("agents");
  });

  it("each chat reopens on the tab it last chose, and no other chat's choice moves it", () => {
    const { tab, page } = load({ id: "ide-todo" });
    tab.rememberTab("terminal");
    expect(tab.openingTab()).toBe("terminal");
    page.activeChat = { id: "ide-notes" };
    expect(tab.openingTab()).toBe("preview");
    page.activeChat = { id: "chat-1" };
    tab.rememberTab("artifacts");
    page.activeChat = { id: "ide-todo" };
    expect(tab.openingTab()).toBe("terminal");
  });
});

describe("preview-tab.js — switching chats with the panel open", () => {
  it("leaves Preview for a chat that never chose it", () => {
    const { tab, page, switched } = load({ id: "ide-glasses" }, { panelOpen: true });
    page.switchSidePanelTab("preview");
    page.activeChat = { id: "chat-1" };
    tab.onChatChanged();
    expect(switched).toEqual(["preview", "agents"]);
  });

  it("turns back to Preview on returning to the code session", () => {
    const { tab, page } = load({ id: "ide-glasses" }, { panelOpen: true });
    page.switchSidePanelTab("preview");
    page.activeChat = { id: "chat-1" };
    tab.onChatChanged();
    page.activeChat = { id: "ide-glasses" };
    tab.onChatChanged();
    expect(page.sidePanelTab).toBe("preview");
  });

  it("unloads the app on leaving its chat, though the Preview tab is hidden", () => {
    const { tab, page, frame } = load({ id: "ide-glasses" }, { panelOpen: true });
    page.switchSidePanelTab("preview");
    expect(frame.src).toBe("/apps/glasses/index.html");
    page.activeChat = { id: "chat-1" };
    tab.onChatChanged();
    expect(page.sidePanelTab).toBe("agents");
    expect(frame.src).toBe("about:blank");
  });

  it("shows the next app on moving between two apps' sessions", () => {
    const { tab, page, frame } = load({ id: "ide-glasses" }, { panelOpen: true });
    page.switchSidePanelTab("preview");
    page.activeChat = { id: "ide-todo" };
    tab.onChatChanged();
    expect(frame.src).toBe("/apps/todo/index.html");
  });

  it("does not switch a closed panel, or one already on the chat's tab", () => {
    const closed = load({ id: "ide-glasses" });
    closed.page.activeChat = { id: "chat-1" };
    closed.tab.onChatChanged();
    expect(closed.switched).toEqual([]);
    const open = load({ id: "chat-1" }, { panelOpen: true });
    open.page.activeChat = { id: "chat-2" };
    open.tab.onChatChanged();
    expect(open.switched).toEqual([]);
  });

  it("keeps a bounded memory, dropping the oldest chats first", () => {
    const { tab, page, store } = load({ id: "chat-0" });
    for (let i = 0; i < 205; i++) { page.activeChat = { id: `chat-${i}` }; tab.rememberTab("inbox"); }
    const byChat = JSON.parse(store.get("lax_side_tab_by_chat")!);
    expect(Object.keys(byChat)).toHaveLength(200);
    expect(byChat["chat-0"]).toBeUndefined();
    expect(byChat["chat-204"]).toBe("inbox");
  });
});

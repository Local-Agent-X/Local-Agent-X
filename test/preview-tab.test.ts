// The right panel's Preview tab (public/js/preview-tab.js): a code session
// opens the panel on it, each mode remembers the tab last chosen in it, and a
// chat keeps the panel's own default.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/preview-tab.js"), "utf8");

type Tab = { onTabShown(): void; onChatChanged(): void; rememberTab(t: string): void; openingTab(): string | null };

function load(chat: { id: string; mode?: string } | null) {
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const window: { laxPreviewTab?: Tab } = {};
  const chatModeOf = (c: { id: string; mode?: string } | null) => (c && (c.mode === "code" || c.id.startsWith("ide-")) ? "code" : "chat");
  const document = { getElementById: () => null };
  // eslint-disable-next-line no-new-func
  new Function("window", "localStorage", "document", "activeChat", "chatModeOf", src)(window, localStorage, document, chat, chatModeOf);
  return { tab: window.laxPreviewTab!, store };
}

describe("preview-tab.js — which tab the panel opens on", () => {
  it("a code session opens on Preview by default", () => {
    expect(load({ id: "ide-todo" }).tab.openingTab()).toBe("preview");
    expect(load({ id: "chat-1", mode: "code" }).tab.openingTab()).toBe("preview");
  });

  it("a code session reopens on the tab last chosen in a code session", () => {
    const { tab, store } = load({ id: "ide-todo" });
    tab.rememberTab("terminal");
    expect(store.get("lax_side_tab_code")).toBe("terminal");
    expect(tab.openingTab()).toBe("terminal");
  });

  it("a chat keeps the panel's own default, and its choice never moves a code session's", () => {
    const { tab, store } = load({ id: "chat-1" });
    expect(tab.openingTab()).toBeNull();
    tab.rememberTab("artifacts");
    expect(store.get("lax_side_tab_chat")).toBe("artifacts");
    expect(store.has("lax_side_tab_code")).toBe(false);
  });
});

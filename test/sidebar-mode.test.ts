// The sidebar's Chat / Code toggle (public/js/sidebar-mode.js). A session is a
// chat or a code session (src/session/mode.ts); each side lists only its own,
// and the code side groups code sessions by the project folder they work in,
// with the App IDE's sessions under Apps.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../public/js/sidebar-mode.js"), "utf8");

type Chat = { id: string; title: string; mode?: string; projectId?: string; archived?: boolean };
type Project = { id: string; name: string; workspace?: string; codeFolder?: boolean };

/** The module over a fake DOM: elements by id, each with a class list. */
function load(state: { chats: Chat[]; projects: Project[]; codeFolders?: Project[]; stored?: string }) {
  const els = new Map<string, { classes: Set<string>; textContent: string; innerHTML: string; attrs: Record<string, string> }>();
  const el = (id: string) => {
    if (!els.has(id)) els.set(id, { classes: new Set(), textContent: "", innerHTML: "", attrs: {} });
    const e = els.get(id)!;
    return {
      classList: { toggle: (c: string, on: boolean) => { if (on) e.classes.add(c); else e.classes.delete(c); } },
      setAttribute: (k: string, v: string) => { e.attrs[k] = v; },
      set textContent(v: string) { e.textContent = v; },
      set innerHTML(v: string) { e.innerHTML = v; },
    };
  };
  const listeners: Array<{ type: string; fn: (e: unknown) => void; capture: boolean }> = [];
  const document = {
    getElementById: el,
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => listeners.push({ type, fn, capture: !!capture }),
  };
  const store = new Map<string, string>(state.stored ? [["lax_sidebar_mode", state.stored]] : []);
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const esc = (s: string) => s;
  const renders: string[] = [];
  const renderSidebar = () => renders.push("sidebar");
  const selected: string[] = [];
  const selectChat = (id: string) => selected.push(id);
  // eslint-disable-next-line no-new-func
  const api = new Function("document", "localStorage", "window", "chats", "projects", "codeFolders", "activeChat", "esc", "renderSidebar", "selectChat",
    `${src}; return { chatModeOf, inSidebarMode, setSidebarMode, renderCodeSidebar, get mode() { return sidebarMode; } };`,
  )(document, localStorage, {}, state.chats, state.projects, state.codeFolders ?? [], null, esc, renderSidebar, selectChat);
  return { api, els, store, renders, listeners, selected };
}

describe("sidebar-mode.js", () => {
  it("reads a session's mode from the server field, and an App IDE session by its id", () => {
    const { api } = load({ chats: [], projects: [] });
    expect(api.chatModeOf({ id: "chat-1" })).toBe("chat");
    expect(api.chatModeOf({ id: "chat-2", mode: "code" })).toBe("code");
    expect(api.chatModeOf({ id: "ide-todo" })).toBe("code");
  });

  it("opens on the side remembered last time, chat by default", () => {
    expect(load({ chats: [], projects: [] }).api.mode).toBe("chat");
    expect(load({ chats: [], projects: [], stored: "code" }).api.mode).toBe("code");
  });

  it("switching sides remembers it, relabels New, hides the chat-only sections and re-renders", () => {
    const { api, els, store, renders } = load({ chats: [], projects: [] });
    api.setSidebarMode("code");
    expect(store.get("lax_sidebar_mode")).toBe("code");
    expect(els.get("new-chat-label")!.textContent).toBe("New code session");
    for (const id of ["pinned-section", "projects-section", "chat-search-bar", "mobile-section", "chats-header"]) {
      expect(els.get(id)!.classes.has("hidden-in-code-mode"), id).toBe(true);
    }
    expect(els.get("sidebar-mode-code")!.attrs["aria-pressed"]).toBe("true");
    expect(renders).toContain("sidebar");
    api.setSidebarMode("chat");
    expect(els.get("projects-section")!.classes.has("hidden-in-code-mode")).toBe(false);
  });

  it("the code side lists your project folders, then Apps, then sessions with no folder", () => {
    const chats: Chat[] = [
      { id: "chat-a", title: "fix the build", mode: "code", projectId: "p1" },
      { id: "chat-b", title: "a chat", projectId: "p1" },
      { id: "ide-todo", title: "IMPORTANT: You are in IDE mode editing an app...", mode: "code" },
      { id: "chat-c", title: "stray", mode: "code" },
      { id: "chat-d", title: "old", mode: "code", projectId: "p1", archived: true },
    ];
    // p3 is a chat project whose folder points at an app the agent built (the
    // "Food Truck Tracker" that appeared on the code side): not a code folder.
    const { api } = load({
      chats,
      projects: [{ id: "p2", name: "no folder" }, { id: "p3", name: "Food Truck Tracker", workspace: "workspace/apps/food-truck-tracker" }],
      codeFolders: [{ id: "p1", name: "repo", workspace: "C:/repo", codeFolder: true }],
    });
    const target = { innerHTML: "" };
    api.renderCodeSidebar(target);
    const html = target.innerHTML;
    const at = (s: string) => html.indexOf(s);
    expect(at("<span>Project folders</span>")).toBeGreaterThan(-1);
    expect(at('<span class="code-group-name">repo</span>')).toBeGreaterThan(at("<span>Project folders</span>"));
    expect(at("fix the build")).toBeGreaterThan(at('<span class="code-group-name">repo</span>'));
    expect(at('<span class="code-group-name">Apps</span>')).toBeGreaterThan(at("fix the build"));
    // An App IDE session is named after its app, not its instruction block.
    expect(at(">todo<")).toBeGreaterThan(at('<span class="code-group-name">Apps</span>'));
    expect(html).not.toContain("IMPORTANT:");
    expect(at('<span class="code-group-name">No folder</span>')).toBeGreaterThan(at(">todo<"));
    expect(at("stray")).toBeGreaterThan(at('<span class="code-group-name">No folder</span>'));
    expect(html).not.toContain("a chat");
    expect(html).not.toContain(">old<");
    expect(html).not.toContain('<span class="code-group-name">no folder</span>');
    expect(html).not.toContain("Food Truck Tracker");
    expect(html).toContain('onclick="addProjectFolder();event.stopPropagation()"');
  });

  it("Open in Code on an app's result opens that app's code session, and stops the click there", () => {
    const chats: Chat[] = [];
    const { api, listeners, selected } = load({ chats, projects: [] });
    const click = listeners.find((l) => l.type === "click")!;
    expect(click.capture).toBe(true);
    const btn = { getAttribute: (k: string) => (k === "data-open-code" ? "todo" : null) };
    let stopped = false;
    click.fn({ target: { closest: (sel: string) => (sel === "[data-open-code]" ? btn : null) }, preventDefault() {}, stopPropagation() { stopped = true; } });
    expect(selected).toEqual(["ide-todo"]);
    expect(chats[0]).toMatchObject({ id: "ide-todo", mode: "code" });
    expect(api.mode).toBe("code");
    expect(stopped).toBe(true);
  });

  it("leaves every other click alone", () => {
    const { listeners, selected } = load({ chats: [], projects: [] });
    let stopped = false;
    listeners[0].fn({ target: { closest: () => null }, preventDefault() {}, stopPropagation() { stopped = true; } });
    expect(selected).toEqual([]);
    expect(stopped).toBe(false);
  });
});

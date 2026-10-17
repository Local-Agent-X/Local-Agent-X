// @vitest-environment happy-dom
//
// The side panel's INBOX tab (opened by the bell) is the view of the server
// inbox (src/inbox/): it renders the
// server's list with needs-you items pinned on top, escapes every server
// string, merges live inbox_item frames (toasting the ones that need the
// user), refetches on inbox_changed, answers approvals through
// /api/inbox/act, and renders the tab-local app-error items through the same
// list. Drives the REAL source files.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
const g = globalThis as unknown as Record<string, unknown>;

interface Bell {
  loadInbox: () => Promise<void>;
  handleInboxFrame: (msg: unknown) => void;
  addNotification: (text: string, type?: string) => void;
  renderNotifications: () => void;
}

const NOW = Date.now();
const serverItems = [
  { id: "inb_info", kind: "job", title: "Background task finished", body: "ok", createdAt: NOW - 1000, needsYou: false },
  { id: "inb_urgent", kind: "agent-message", title: "Ada <img src=x onerror=alert(1)> needs you", body: "<script>steal()</script>", createdAt: NOW - 5000, needsYou: true, link: { agentId: "tpl-ada" }, actions: [{ id: "approve", label: "Approve" }] },
];

function load(): Bell {
  document.body.innerHTML = '<span id="notif-badge" style="display:none"></span><span id="inbox-count" style="display:none"></span><div id="notif-list"></div>';
  new Function(src("shared-escape.js") + "\nglobalThis.esc = esc;")();
  // The Open link is the AGENTS card's (chat-agent-feeds-render.js); its two
  // globals are the files-link signer (shared-md.js) and the operator token.
  g.agentFilesHref = (u: string) => u;
  g.AUTH_TOKEN = "tok";
  return new Function(src("chat-agent-feeds-render.js") + "\n" + src("notifications.js") + "\nreturn { loadInbox, handleInboxFrame, addNotification, renderNotifications };")() as Bell;
}

interface Panel {
  toggleInboxTab: () => void;
  switchSidePanelTab: (tab: string) => void;
  isOpen: () => boolean;
}

// The real tab switcher (chat-artifacts.js) and the bell in one scope, with the
// panel's open/close (chat-agent-feeds.js) reduced to its flag.
function loadPanel(): Panel {
  document.body.innerHTML = '<span id="notif-badge"></span>'
    + '<button id="side-tab-agents" class="active"></button><button id="side-tab-inbox"></button><button id="side-tab-artifacts"></button>'
    + '<span id="inbox-count"></span><div id="agents-tab-body"></div><div id="artifacts-tab-body" style="display:none"></div>'
    + '<div id="inbox-tab-body" style="display:none"><div id="notif-list"></div></div>';
  new Function(src("shared-escape.js") + "\nglobalThis.esc = esc;")();
  return new Function("var agentFeedsOpen = false;\nfunction toggleAgentFeeds() { agentFeedsOpen = !agentFeedsOpen; }\n"
    + src("chat-artifacts.js") + "\n" + src("notifications.js")
    + "\nreturn { toggleInboxTab, switchSidePanelTab, isOpen: function () { return agentFeedsOpen; } };")() as Panel;
}

let posted: Array<{ path: string; body: unknown }>;
beforeEach(() => {
  posted = [];
  g.apiFetch = vi.fn(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") { posted.push({ path, body: JSON.parse(opts.body || "{}") }); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ items: serverItems, unread: 2, needsYou: 1 }) };
  });
  (g.window as Record<string, unknown>).desktop = { showNotification: vi.fn() };
});

const rows = () => [...document.querySelectorAll("#notif-list [data-inbox-id]")].map((el) => el.getAttribute("data-inbox-id"));

describe("the bell renders the server inbox", () => {
  it("pins needs-you items on top, shows the unread badge, and escapes every server string", async () => {
    const bell = load();
    await bell.loadInbox();
    expect(rows()).toEqual(["inb_urgent", "inb_info"]);
    expect(document.getElementById("notif-badge")!.textContent).toBe("2");
    const list = document.getElementById("notif-list")!;
    expect(list.querySelector("img")).toBeNull();
    expect(list.querySelector("script")).toBeNull();
    expect(list.textContent).toContain("Ada <img src=x onerror=alert(1)> needs you");
    expect(list.querySelector(".needs-you .notif-kind")!.textContent).toBe("Agent");
    const approve = [...list.querySelectorAll("button")].find((b) => b.textContent === "Approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it("a finished job with a result shows an Open link to it; clicking it marks the item read and leaves the chat alone", async () => {
    const selectChat = vi.fn();
    g.selectChat = selectChat;
    g.chats = [{ id: "sess-1" }];
    const bell = load();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 3, needsYou: 1, item: { id: "inb_app", kind: "job", title: 'Background task "build a water tracker" finished', body: "done", createdAt: NOW, needsYou: false, link: { sessionId: "sess-1", opId: "op1", url: "/apps/water-tracker/" } } });
    const row = document.querySelector('[data-inbox-id="inb_app"]')!;
    const open = row.querySelector("a") as HTMLAnchorElement;
    expect(open.getAttribute("href")).toBe("/apps/water-tracker/");
    expect(open.textContent).toContain("Open: /apps/water-tracker/");
    expect(document.querySelector('[data-inbox-id="inb_info"] a')).toBeNull();
    open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(posted).toContainEqual({ path: "/api/inbox/read", body: { id: "inb_app" } }));
    expect(selectChat).not.toHaveBeenCalled();
  });

  it("an inbox_item frame merges the item and toasts only when it needs the user", async () => {
    const bell = load();
    await bell.loadInbox();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 3, needsYou: 1, item: { id: "inb_new", kind: "job", title: "Report finished", body: "", createdAt: NOW, needsYou: false } });
    const toast = (g.window as { desktop: { showNotification: ReturnType<typeof vi.fn> } }).desktop.showNotification;
    expect(toast).not.toHaveBeenCalled();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 4, needsYou: 2, item: { id: "inb_parked", kind: "approval", title: "Scheduled job wants to run bash", body: "BLOCKED", createdAt: NOW, needsYou: true } });
    expect(toast).toHaveBeenCalledWith("Scheduled job wants to run bash", "BLOCKED");
    expect(rows()).toEqual(["inb_parked", "inb_urgent", "inb_new", "inb_info"]);
    expect(document.getElementById("notif-badge")!.textContent).toBe("4");
  });

  it("inbox_changed refetches the list", async () => {
    const bell = load();
    bell.handleInboxFrame({ type: "inbox_changed", action: "dismiss", unread: 0, needsYou: 0 });
    await vi.waitFor(() => expect(rows()).toEqual(["inb_urgent", "inb_info"]));
  });

  it("Dismiss and Done post to the server with the item id", async () => {
    const bell = load();
    await bell.loadInbox();
    const urgent = document.querySelector('[data-inbox-id="inb_urgent"]')!;
    (urgent.querySelector('[data-inbox-act="resolve"]') as HTMLButtonElement).click();
    (urgent.querySelector('[data-inbox-act="dismiss"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(posted).toEqual([
      { path: "/api/inbox/resolve", body: { id: "inb_urgent" } },
      { path: "/api/inbox/dismiss", body: { id: "inb_urgent" } },
    ]));
  });

  it("an open approval shows its whole body and only Approve / Decline; Approve posts the answer once and shows the outcome item when it arrives", async () => {
    const longBody = "Tool: bash\nCommand: npm publish\n\nWhy it needs you: " + "x".repeat(600);
    const approval = { id: "inb_ok", kind: "approval", title: "Scheduled job wants to run bash", body: longBody, createdAt: NOW, needsYou: true, actions: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] };
    let release: () => void = () => {};
    g.apiFetch = vi.fn(async (path: string, opts?: { method?: string; body?: string }) => {
      if (opts?.method === "POST") {
        posted.push({ path, body: JSON.parse(opts.body || "{}") });
        await new Promise<void>((r) => { release = r; });
        return { ok: true, json: async () => ({ ok: true, resolution: "approved" }) };
      }
      return { ok: true, json: async () => ({ items: [approval], unread: 1, needsYou: 1 }) };
    });
    const bell = load();
    await bell.loadInbox();
    const row = () => document.querySelector('[data-inbox-id="inb_ok"]')!;
    expect(row().querySelector(".notif-kind")!.textContent).toBe("Needs your OK");
    expect(row().querySelector(".notif-body")!.textContent).toBe(longBody);
    const labels = [...row().querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Approve", "Decline", "Mark read"]);
    const approve = row().querySelector('[data-inbox-answer="approve"]') as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    approve.click();
    (row().querySelector('[data-inbox-answer="approve"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(row().querySelector(".notif-resolution")?.textContent).toBe("Running…"));
    expect((row().querySelector('[data-inbox-answer="approve"]') as HTMLButtonElement).disabled).toBe(true);
    expect(posted).toEqual([{ path: "/api/inbox/act", body: { id: "inb_ok", action: "approve" } }]);
    release();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 1, needsYou: 0, item: { id: "inb_result", kind: "job", title: "Your approved bash call ran", body: "ran", createdAt: NOW + 1, needsYou: false } });
    expect(rows()).toContain("inb_result");
  });

  it("an answered approval shows how it was answered and can be dismissed", async () => {
    const answered = { id: "inb_done", kind: "approval", title: "t", body: "b", createdAt: NOW, needsYou: true, resolvedAt: NOW, readAt: NOW, resolution: "declined", actions: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }] };
    g.apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [answered], unread: 0, needsYou: 0 }) }));
    const bell = load();
    await bell.loadInbox();
    const row = document.querySelector('[data-inbox-id="inb_done"]')!;
    expect(row.querySelector(".notif-resolution")!.textContent).toBe("Declined");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss"]);
  });

  it("a tab-local app error renders in the same list, escaped, and is dismissed without the server", async () => {
    const bell = load();
    await bell.loadInbox();
    bell.addNotification("Redirect not delivered — <b>network error</b>.", "error");
    const local = document.querySelector('[data-inbox-id^="local-"]')!;
    expect(local.querySelector(".notif-kind")!.textContent).toBe("Error");
    expect(local.querySelector("b")).toBeNull();
    expect(document.getElementById("notif-badge")!.textContent).toBe("3");
    (local.querySelector('[data-inbox-act="dismiss"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-inbox-id^="local-"]')).toBeNull());
    expect(posted).toEqual([]);
  });

  it("the unread count shows on the INBOX tab as well as the bell", async () => {
    const bell = load();
    await bell.loadInbox();
    const tabCount = document.getElementById("inbox-count")!;
    expect(tabCount.textContent).toBe("2");
    expect(tabCount.style.display).toBe("");
  });

  it("no longer keeps a localStorage copy", () => {
    localStorage.setItem("lax_notifications", JSON.stringify([{ text: "stale", read: false }]));
    load();
    expect(localStorage.getItem("lax_notifications")).toBeNull();
  });
});

describe("the inbox is a tab of the side panel", () => {
  const shown = (id: string) => document.getElementById(id)!.style.display !== "none";

  it("the bell opens the closed panel on the INBOX tab and loads the list", async () => {
    const panel = loadPanel();
    panel.toggleInboxTab();
    expect(panel.isOpen()).toBe(true);
    expect(shown("inbox-tab-body")).toBe(true);
    expect(shown("agents-tab-body")).toBe(false);
    expect(document.getElementById("side-tab-inbox")!.classList.contains("active")).toBe(true);
    await vi.waitFor(() => expect(rows()).toEqual(["inb_urgent", "inb_info"]));
  });

  it("on another tab the bell switches to INBOX without closing; on INBOX it closes the panel", () => {
    const panel = loadPanel();
    panel.toggleInboxTab();
    panel.switchSidePanelTab("agents");
    panel.toggleInboxTab();
    expect(panel.isOpen()).toBe(true);
    expect(shown("inbox-tab-body")).toBe(true);
    panel.toggleInboxTab();
    expect(panel.isOpen()).toBe(false);
  });

  it("app.html has no floating notification panel: the list lives in the INBOX tab body", () => {
    const html = readFileSync(join(here, "../public/app.html"), "utf8");
    const page = new DOMParser().parseFromString(html.slice(html.indexOf("<body"), html.lastIndexOf("</body>")), "text/html");
    expect(page.getElementById("notif-panel")).toBeNull();
    expect(page.getElementById("notif-list")!.closest("#inbox-tab-body")).not.toBeNull();
    expect(page.getElementById("side-tab-inbox")!.closest(".agent-feeds-header")).not.toBeNull();
  });
});

// @vitest-environment happy-dom
//
// The bell is the view of the server inbox (src/inbox/): it renders the
// server's list with needs-you items pinned on top, escapes every server
// string, merges live inbox_item frames (toasting the ones that need the
// user), refetches on inbox_changed, and renders the tab-local app-error
// items through the same list. Drives the REAL source files.
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
  document.body.innerHTML = '<span id="notif-badge" style="display:none"></span><div id="notif-panel"></div><div id="notif-list"></div>';
  new Function(src("shared-escape.js") + "\nglobalThis.esc = esc;")();
  return new Function(src("notifications.js") + "\nreturn { loadInbox, handleInboxFrame, addNotification, renderNotifications };")() as Bell;
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

  it("an inbox_item frame merges the item and toasts only when it needs the user", async () => {
    const bell = load();
    await bell.loadInbox();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 3, needsYou: 1, item: { id: "inb_new", kind: "job", title: "Report finished", body: "", createdAt: NOW, needsYou: false } });
    const toast = (g.window as { desktop: { showNotification: ReturnType<typeof vi.fn> } }).desktop.showNotification;
    expect(toast).not.toHaveBeenCalled();
    bell.handleInboxFrame({ type: "inbox_item", created: true, unread: 4, needsYou: 2, item: { id: "inb_refused", kind: "refused-action", title: "Scheduled job: bash needs your OK", body: "BLOCKED", createdAt: NOW, needsYou: true } });
    expect(toast).toHaveBeenCalledWith("Scheduled job: bash needs your OK", "BLOCKED");
    expect(rows()).toEqual(["inb_refused", "inb_urgent", "inb_new", "inb_info"]);
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

  it("no longer keeps a localStorage copy", () => {
    localStorage.setItem("lax_notifications", JSON.stringify([{ text: "stale", read: false }]));
    load();
    expect(localStorage.getItem("lax_notifications")).toBeNull();
  });
});

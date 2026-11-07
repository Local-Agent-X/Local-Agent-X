// @vitest-environment happy-dom
// The reply's step list and recap in the desktop chat (chat-progress.js): the list is
// the newest metadata.plan any task tool carried, the recap is wrap_up's
// metadata.wrapUp, an answer button sends its words as the next message, and the two
// bookkeeping tools are kept out of the activity group.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;
type Step = { text: string; status: string };
type Wrap = { recap: string; ask?: string; actions?: string[] };
type Progress = {
  isProgressTool: (name: string) => boolean;
  planOf: (events: unknown[]) => Step[] | null;
  wrapUpOf: (events: unknown[]) => Wrap | null;
  renderPlanList: (steps: Step[]) => HTMLElement;
  renderWrapUp: (wrap: Wrap) => HTMLElement;
  sessionOffersOf: (events: unknown[]) => Offer[];
  renderSessionOffer: (offer: Offer) => HTMLElement;
};
type Offer = { title: string; brief: string };

let p: Progress;

beforeEach(() => {
  g.esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const src = readFileSync(join(here, "../public/js/chat-progress.js"), "utf8");
  // eslint-disable-next-line no-new-func
  p = new Function(`${src}; return { isProgressTool, planOf, wrapUpOf, renderPlanList, renderWrapUp, sessionOffersOf, renderSessionOffer };`)() as Progress;
  document.body.innerHTML = '<textarea id="msg-input"></textarea>';
});

describe("the reply's step list", () => {
  it("is the newest list any task tool carried", () => {
    const events = [
      { type: "end", name: "update_plan", metadata: { plan: [{ text: "Read", status: "in_progress" }, { text: "Fix", status: "pending" }] } },
      { type: "end", name: "edit", metadata: {} },
      { type: "end", name: "update_plan", metadata: { plan: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] } },
    ];
    expect(p.planOf(events)!.map((s) => s.status)).toEqual(["completed", "in_progress"]);
    expect(p.planOf([{ type: "end", name: "edit", metadata: {} }])).toBeNull();
  });

  it("draws each step with its mark and the done count", () => {
    const el = p.renderPlanList([{ text: "Read <code>", status: "completed" }, { text: "Fix", status: "in_progress" }]);
    expect(el.querySelector(".chat-plan-head")!.textContent).toContain("1 of 2");
    expect(el.querySelectorAll(".chat-plan-step.completed")).toHaveLength(1);
    expect(el.querySelector("code")).toBeNull();
    expect(el.textContent).toContain("Read <code>");
  });
});

describe("the recap", () => {
  it("draws the recap and question, and a button sends its words as the next message", () => {
    const send = vi.fn();
    g.sendMessage = send;
    const el = p.renderWrapUp({ recap: "Fixed it.", ask: "Push it?", actions: ["Yes, push", "Not now"] });
    document.body.appendChild(el);
    expect(el.querySelector(".chat-wrapup-ask")!.textContent).toBe("Push it?");
    const buttons = el.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toContain("primary");
    buttons[0]!.click();
    expect((document.getElementById("msg-input") as HTMLTextAreaElement).value).toBe("Yes, push");
    expect(send).toHaveBeenCalledOnce();
  });

  it("draws no buttons without a question", () => {
    expect(p.renderWrapUp({ recap: "Done.", actions: ["Yes"] }).querySelector("button")).toBeNull();
  });

  it("keeps update_plan and wrap_up out of the activity group, and nothing else", () => {
    expect(p.isProgressTool("update_plan")).toBe(true);
    expect(p.isProgressTool("wrap_up")).toBe(true);
    expect(p.isProgressTool("task_create")).toBe(false);
    expect(p.wrapUpOf([{ type: "end", name: "wrap_up", metadata: { wrapUp: { recap: "Done." } } }])).toEqual({ recap: "Done." });
  });
});

describe("a separate task offered its own chat", () => {
  const offer = { title: "Fix <b>Recents</b>", brief: "The sheet overlaps the dock. <img src=x onerror=alert(1)>" };

  it("lists every offer the turn made, and keeps session_start out of the activity group", () => {
    const events = [
      { type: "end", name: "session_start", metadata: { sessionOffer: offer } },
      { type: "end", name: "edit", metadata: {} },
      { type: "end", name: "session_start", metadata: { sessionOffer: { title: "Docs", brief: "Update the README." } } },
    ];
    expect(p.sessionOffersOf(events).map((o) => o.title)).toEqual(["Fix <b>Recents</b>", "Docs"]);
    expect(p.isProgressTool("session_start")).toBe(true);
  });

  it("shows the title and the whole brief as text, never as markup", () => {
    const el = p.renderSessionOffer(offer);
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("Fix <b>Recents</b>");
    expect(el.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("starts the chat on a tap, adds it to the list, then opens it", async () => {
    const chats: Array<Record<string, unknown>> = [];
    g.chats = chats;
    g.activeChat = { id: "origin" };
    g.saveChats = vi.fn();
    g.renderSidebar = vi.fn();
    const select = vi.fn();
    g.selectChat = select;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, sessionId: "task-1", title: offer.title }) }));
    g.apiFetch = fetchMock;
    const el = p.renderSessionOffer(offer);
    const btn = el.querySelector("button")!;
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("Open"));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body))).toEqual({ sessionId: "origin", title: offer.title, brief: offer.brief });
    expect(chats).toEqual([expect.objectContaining({ id: "task-1", startedFrom: "origin" })]);
    btn.click();
    expect(select).toHaveBeenCalledWith("task-1");
  });
});

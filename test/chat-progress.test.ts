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
};

let p: Progress;

beforeEach(() => {
  g.esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const src = readFileSync(join(here, "../public/js/chat-progress.js"), "utf8");
  // eslint-disable-next-line no-new-func
  p = new Function(`${src}; return { isProgressTool, planOf, wrapUpOf, renderPlanList, renderWrapUp };`)() as Progress;
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

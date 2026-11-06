/**
 * The chat's step list and recap: update_plan writes the session's steps to the
 * task store, every task tool's result carries them as metadata.plan (what the
 * desktop and the phone draw under the reply), and wrap_up's recap rides
 * metadata.wrapUp and closes the step in progress.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// task-tools computes its TASKS_PATH from getLaxDir() at module load.
const DATA_DIR = mkdtempSync(join(tmpdir(), "step-list-"));
process.env.LAX_DATA_DIR = DATA_DIR;
const TASKS_FILE = join(DATA_DIR, "tasks.json");

const { taskTools, getOpenTasksForSession } = await import("./task-tools.js");
const { wrapUpTool, wrapUpOf } = await import("./wrap-up.js");
const { isLedgerTool } = await import("../committing-tool-check.js");
const tool = (n: string) => taskTools.find((t) => t.name === n)!;
const plan = tool("update_plan");

beforeEach(() => { try { if (existsSync(TASKS_FILE)) unlinkSync(TASKS_FILE); } catch { /* ignore */ } });
afterAll(() => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* win locks */ } });

const items = [
  { content: "Read the code", status: "in_progress" },
  { content: "Make the change", status: "pending" },
  { content: "Run the tests", status: "pending" },
];

describe("update_plan", () => {
  it("sets the whole list and returns it as the plan the chat draws", async () => {
    const r = await plan.execute({ items, _sessionId: "chat-1" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.plan).toEqual([
      { text: "Read the code", status: "in_progress" },
      { text: "Make the change", status: "pending" },
      { text: "Run the tests", status: "pending" },
    ]);
    expect(r.content).toBe("Steps: 0 of 3 done; now: Read the code.");
  });

  it("advance completes the current step and starts the next", async () => {
    await plan.execute({ items, _sessionId: "chat-1" });
    const r = await plan.execute({ advance: true, _sessionId: "chat-1" });
    expect((r.metadata?.plan as Array<{ status: string }>).map((s) => s.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  it("a new list replaces only this session's steps", async () => {
    await plan.execute({ items, _sessionId: "chat-1" });
    await plan.execute({ items, _sessionId: "chat-2" });
    await plan.execute({ items: [{ content: "Something else", status: "in_progress" }], _sessionId: "chat-1" });
    expect(getOpenTasksForSession("chat-1").map((t) => t.description)).toEqual(["Something else"]);
    expect(getOpenTasksForSession("chat-2")).toHaveLength(3);
  });

  it("refuses without a session, an empty list, or neither items nor advance", async () => {
    expect((await plan.execute({ items })).isError).toBe(true);
    expect((await plan.execute({ items: [], _sessionId: "chat-1" })).isError).toBe(true);
    expect((await plan.execute({ _sessionId: "chat-1" })).isError).toBe(true);
    expect((await plan.execute({ items: [{ content: "x", status: "maybe" }], _sessionId: "chat-1" })).isError).toBe(true);
  });

  it("task_create and task_update carry the same list, so the chat follows either tool", async () => {
    const c = await tool("task_create").execute({ description: "Ship it", id: "ship", _sessionId: "chat-3" });
    expect(c.metadata?.plan).toEqual([{ text: "Ship it", status: "pending" }]);
    const u = await tool("task_update").execute({ id: "ship", status: "completed", _sessionId: "chat-3" });
    expect(u.metadata?.plan).toEqual([{ text: "Ship it", status: "completed" }]);
  });
});

describe("wrap_up", () => {
  it("carries the recap, and buttons only with a question", () => {
    expect(wrapUpOf({ recap: "Done.", actions: ["Yes"] })).toEqual({ recap: "Done." });
    expect(wrapUpOf({ recap: "Done.", ask: "Push it?", actions: ["Yes, push", "Not now", "Later"] }))
      .toEqual({ recap: "Done.", ask: "Push it?", actions: ["Yes, push", "Not now"] });
    expect(wrapUpOf({ recap: "  " })).toBeNull();
  });

  it("closes the step in progress and leaves a pending one open for the open-steps gate", async () => {
    await plan.execute({ items, _sessionId: "chat-4" });
    const r = await wrapUpTool.execute({ recap: "Read it.", _sessionId: "chat-4" });
    expect(r.metadata?.wrapUp).toEqual({ recap: "Read it." });
    expect((r.metadata?.plan as Array<{ status: string }>).map((s) => s.status)).toEqual(["completed", "pending", "pending"]);
    expect(getOpenTasksForSession("chat-4")).toHaveLength(2);
  });

  it("refuses without a recap", async () => {
    expect((await wrapUpTool.execute({ _sessionId: "chat-4" })).isError).toBe(true);
  });
});

describe("isLedgerTool: the agent's own step list, read from the row's tasks tag", () => {
  it("counts the task tools, update_plan and wrap_up, and no unregistered task_* name", () => {
    for (const name of ["task_create", "task_update", "task_list", "task_get", "update_plan", "wrap_up"]) expect(isLedgerTool(name)).toBe(true);
    expect(isLedgerTool("task_from_a_plugin")).toBe(false);
    expect(isLedgerTool("edit")).toBe(false);
  });
});

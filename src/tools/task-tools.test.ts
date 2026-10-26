/**
 * task_create / task_update id handling.
 *
 * Models name their own task ids (a universal to-do-list prior) and reference
 * them later, so a caller-chosen id is honored and a missing parent is coerced
 * to a root task (Jul 2 2026, food-truck preflight: a server-random id made
 * every later reference miss and the worker derailed). What is NOT tolerated
 * any more: task_list prints the first 8 characters of a generated id, and a
 * task_update by that prefix used to silently create a second task under it
 * while the real one stayed open; a task_create on a taken id silently handed
 * back a different id the model never learned. Both are now resolved (a
 * unique prefix lands on its task) or refused (taken id, unknown or ambiguous
 * prefix) — never silently redirected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// task-tools computes its TASKS_PATH from getLaxDir() at module load, so the
// data dir must be set before the first import below. One dir for the file;
// the tasks file is reset between tests.
const DATA_DIR = mkdtempSync(join(tmpdir(), "task-tools-"));
process.env.LAX_DATA_DIR = DATA_DIR;
const TASKS_FILE = join(DATA_DIR, "tasks.json");

const { taskTools } = await import("./task-tools.js");
const tool = (n: string) => taskTools.find((t) => t.name === n)!;
const create = tool("task_create");
const update = tool("task_update");
const get = tool("task_get");
const list = tool("task_list");

beforeEach(() => { try { if (existsSync(TASKS_FILE)) unlinkSync(TASKS_FILE); } catch { /* ignore */ } });
afterEach(() => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* win locks */ } });

describe("task_create — model-assigned ids", () => {
  it("honors a caller-chosen id so later references resolve", async () => {
    const r = await create.execute({ description: "setup", id: "preflight-1" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.id).toBe("preflight-1");
    const g = await get.execute({ id: "preflight-1" });
    expect(g.isError).toBeFalsy();
  });

  it("coerces a missing parent to a root task instead of erroring", async () => {
    const r = await create.execute({ description: "step 1", parent_id: "preflight-1" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("root task");
  });

  it("refuses a taken id instead of silently swapping in another", async () => {
    await create.execute({ description: "first", id: "dup" });
    const r = await create.execute({ description: "second", id: "dup" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/"dup" is already taken by "first" \(pending\)/);
    expect((await list.execute({ all_sessions: true })).content).toMatch(/^1 tasks/);
  });
});

describe("task_update — resolves the id, never creates", () => {
  it("errors on an unknown id without creating anything", async () => {
    const r = await update.execute({ id: "preflight-1-1", status: "completed", output: "read sentinel" });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/No task with id "preflight-1-1"/);
    expect((await get.execute({ id: "preflight-1-1" })).isError).toBe(true);
  });

  it("the 8-character prefix task_list prints resolves to the generated id", async () => {
    const c = await create.execute({ description: "generated" });
    const full = String(c.metadata?.id);
    const shown = (await list.execute({ all_sessions: true })).content.match(/\(([0-9a-f-]{8})\)/)?.[1];
    expect(shown).toBe(full.slice(0, 8));
    const r = await update.execute({ id: shown, status: "completed" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`Task ${full} updated — status: completed`);
    expect((await list.execute({ all_sessions: true })).content).toMatch(/^1 tasks \(1 completed\)/);
    expect((await get.execute({ id: shown })).content).toContain(`ID:          ${full}`);
  });

  it("an ambiguous prefix is refused and the candidates named", async () => {
    await create.execute({ description: "a", id: "step-1" });
    await create.execute({ description: "b", id: "step-10" });
    const r = await update.execute({ id: "step-1", status: "completed" });
    expect(r.isError).toBeFalsy(); // exact id wins over its own prefix
    const amb = await update.execute({ id: "step", status: "completed" });
    expect(amb.isError).toBe(true);
    expect(amb.content).toMatch(/matches 2 tasks: step-1, step-10/);
  });

  it("still updates an existing task in place", async () => {
    await create.execute({ description: "x", id: "t1" });
    const r = await update.execute({ id: "t1", status: "in_progress" });
    expect(r.content).toContain("updated");
    expect(r.content).toContain("in_progress");
  });

  it("rejects an invalid status without creating anything", async () => {
    const r = await update.execute({ id: "ghost", status: "bogus" });
    expect(r.isError).toBe(true);
    const g = await get.execute({ id: "ghost" });
    expect(g.isError).toBe(true);
  });
});

describe("task ids are names within a session", () => {
  it("two sessions may each name a step \"read\", and each update lands on its own", async () => {
    const a = await create.execute({ description: "read the spec", id: "read", _sessionId: "chat-a" });
    expect(a.isError).toBeFalsy();
    const b = await create.execute({ description: "read the deliverable", id: "read", _sessionId: "agent-b" });
    expect(b.isError).toBeFalsy();
    await update.execute({ id: "read", status: "completed", _sessionId: "agent-b" });
    expect((await get.execute({ id: "read", _sessionId: "chat-a" })).content).toContain("pending");
    expect((await get.execute({ id: "read", _sessionId: "agent-b" })).content).toContain("completed");
    expect((await list.execute({ _sessionId: "agent-b" })).content).toMatch(/^1 tasks/);
  });

  it("a taken id is still refused inside one session, and a parent resolves inside it", async () => {
    await create.execute({ description: "first", id: "step", _sessionId: "chat-a" });
    const dup = await create.execute({ description: "second", id: "step", _sessionId: "chat-a" });
    expect(dup.isError).toBe(true);
    await create.execute({ description: "parent", id: "step", _sessionId: "agent-b" });
    const child = await create.execute({ description: "child", parent_id: "step", _sessionId: "agent-b" });
    expect(child.content).not.toContain("not found");
    const detail = await get.execute({ id: "step", _sessionId: "agent-b" });
    expect(detail.content).toContain("Subtasks:    1");
  });

  it("another session's task is not found, by id or by prefix", async () => {
    await create.execute({ description: "theirs", id: "theirs", _sessionId: "chat-a" });
    expect((await get.execute({ id: "theirs", _sessionId: "agent-b" })).isError).toBe(true);
    expect((await update.execute({ id: "the", status: "completed", _sessionId: "agent-b" })).isError).toBe(true);
    expect((await get.execute({ id: "theirs", _sessionId: "chat-a" })).content).toContain("pending");
  });
});

describe("task_list — session isolation", () => {
  it("does not leak failed tasks from prior worker sessions", async () => {
    await create.execute({ description: "old failed step", id: "old", _sessionId: "agent-old" });
    await update.execute({ id: "old", status: "failed", _sessionId: "agent-old" });
    await create.execute({ description: "current step", id: "current", _sessionId: "agent-current" });
    await update.execute({ id: "current", status: "failed", _sessionId: "agent-current" });

    const scoped = await list.execute({ status: "failed", _sessionId: "agent-current" });
    expect(scoped.content).toContain("current step");
    expect(scoped.content).not.toContain("old failed step");

    const global = await list.execute({ status: "failed", all_sessions: true, _sessionId: "agent-current" });
    expect(global.content).toContain("old failed step");
    expect(global.content).toContain("current step");
  });
});

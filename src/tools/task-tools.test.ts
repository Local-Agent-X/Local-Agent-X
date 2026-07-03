/**
 * task_create / task_update tolerance for model-assigned ids.
 *
 * Regression (Jul 2 2026, food-truck preflight): grok named its own task ids
 * (`parent_id: "preflight-1"`, then `task_update id: "preflight-1-1"`), but the
 * old tool discarded the caller's id for a server-random UUID and hard-failed
 * every later reference ("Parent task X not found" × 6). The worker derailed
 * into explaining the errors and never emitted its report block. The tools now
 * honor the model's universal "name my own task ids" prior: caller id is kept,
 * a missing parent is coerced to root, and an update to an unknown id upserts.
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

  it("falls back to a generated id when the requested id is taken", async () => {
    await create.execute({ description: "first", id: "dup" });
    const r = await create.execute({ description: "second", id: "dup" });
    expect(r.isError).toBeFalsy();
    expect(r.metadata?.id).not.toBe("dup");
  });
});

describe("task_update — upsert on unknown id", () => {
  it("creates and sets status when the id was never created", async () => {
    const r = await update.execute({ id: "preflight-1-1", status: "completed", output: "read sentinel" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("created");
    const g = await get.execute({ id: "preflight-1-1" });
    expect(g.content).toContain("completed");
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

  it("a full derailment sequence produces zero errors", async () => {
    // The exact shape of grok's derailing calls: create with phantom parent,
    // then update ids that create() never returned. None may error now. Run
    // sequentially — the on-disk store is last-write-wins, not concurrent.
    const results = [
      await create.execute({ description: "preflight step 1", parent_id: "preflight-1" }),
      await create.execute({ description: "preflight step 2", parent_id: "preflight-1" }),
      await update.execute({ id: "preflight-1-1", status: "completed", output: "read sentinel, got token" }),
      await update.execute({ id: "preflight-1-2", status: "completed", output: "wrote echo" }),
    ];
    expect(results.every((r) => !r.isError)).toBe(true);
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

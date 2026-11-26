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
import type { Op } from "../ops/types.js";

// task-tools computes its TASKS_PATH from getLaxDir() at module load.
const DATA_DIR = mkdtempSync(join(tmpdir(), "step-list-"));
process.env.LAX_DATA_DIR = DATA_DIR;
const TASKS_FILE = join(DATA_DIR, "tasks.json");

const { taskTools, getOpenTasksForSession } = await import("./task-tools.js");
const { wrapUpTool, wrapUpOf, RECAP_MAX_CHARS } = await import("./wrap-up.js");
const { isLedgerTool } = await import("../committing-tool-check.js");
const { writeOp } = await import("../ops/op-store.js");
const { OP_TYPE } = await import("../ops/op-types.js");
const { trackOpForSession, releaseOpFromSession } = await import("../ops/session-bridge.js");
const { setOpLedger, clearOpLedger } = await import("../canonical-loop/public/plan-ledger.js");

function baseOp(id: string, type: string): Op {
  return {
    id,
    type,
    task: id,
    contextPack: {
      task: { description: id, successCriteria: [], constraints: [], notWhatToRedo: [] },
      context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
      capabilities: {},
      budget: { maxIterations: 2, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
      routing: { lane: "interactive" },
      secrets: { allowed: [] },
    },
    lane: "interactive",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] },
    ownerId: "local-user",
    visibility: "private",
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
}
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
    // The recap is the closing answer: room for one, cut beyond it.
    expect(wrapUpOf({ recap: "x".repeat(1400) })!.recap).toHaveLength(1400);
    expect(wrapUpOf({ recap: "x".repeat(RECAP_MAX_CHARS + 50) })!.recap).toHaveLength(RECAP_MAX_CHARS);
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

// A turn that ends by calling wrap_up never reaches the open-steps gate (it
// reads a turn that ends in prose), so the close itself holds the request to
// its own plan (Label Check Sol, 2026-11-26).
describe("wrap_up on a plan with steps not started", () => {
  const statuses = (r: { metadata?: Record<string, unknown> }) => (r.metadata?.plan as Array<{ status: string }>).map((s) => s.status);
  let n = 0;
  /** A chat turn's op, begun `agoMs` ago, and the session it runs in. */
  function turn(agoMs = 60_000): { _sessionId: string; _operationId: string } {
    const id = `op_chat_turn_wrapup_${++n}`;
    const sessionId = `chat-wrap-${n}`;
    writeOp({ ...baseOp(id, OP_TYPE.chatTurn), sessionId, status: "running", createdAt: new Date(Date.now() - agoMs).toISOString() });
    return { _sessionId: sessionId, _operationId: id };
  }

  it("refuses the close once, naming the steps, and leaves the list as it was", async () => {
    const t = turn();
    await plan.execute({ items, ...t });
    const r = await wrapUpTool.execute({ recap: "Read it.", ...t });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("1. Make the change\n2. Run the tests");
    expect(r.metadata?.wrapUp).toBeUndefined();
    expect(getOpenTasksForSession(t._sessionId)).toHaveLength(3);
  });

  it("closes on the second call: the agent has said what stops it", async () => {
    const t = turn();
    await plan.execute({ items, ...t });
    await wrapUpTool.execute({ recap: "Read it.", ...t });
    const again = await wrapUpTool.execute({ recap: "Read it. The change needs your database password.", ...t });
    expect(again.isError).toBeFalsy();
    expect(statuses(again)).toEqual(["completed", "pending", "pending"]);
  });

  it("refuses again after progress, about the steps that are left", async () => {
    const t = turn();
    await plan.execute({ items, ...t });
    await wrapUpTool.execute({ recap: "Read it.", ...t });
    await plan.execute({ advance: true, ...t });
    const r = await wrapUpTool.execute({ recap: "Changed it.", ...t });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("1 step of your plan has not been started");
    expect(r.content).toContain("1. Run the tests");
  });

  it("closes a turn that ends on a question: the steps wait for the answer", async () => {
    const t = turn();
    await plan.execute({ items, ...t });
    const r = await wrapUpTool.execute({ recap: "Read it.", ask: "Change it now?", actions: ["Yes"], ...t });
    expect(r.isError).toBeFalsy();
    expect(statuses(r)).toEqual(["completed", "pending", "pending"]);
  });

  it("closes when the last step is the one in progress", async () => {
    const t = turn();
    await plan.execute({ items: [{ content: "Read the code", status: "completed" }, { content: "Run the tests", status: "in_progress" }], ...t });
    const r = await wrapUpTool.execute({ recap: "All green.", ...t });
    expect(r.isError).toBeFalsy();
    expect(statuses(r)).toEqual(["completed", "completed"]);
  });

  it("does not hold a request to steps an earlier one left open", async () => {
    const earlier = turn();
    await plan.execute({ items, ...earlier });
    await new Promise((r) => setTimeout(r, 5));
    const later = "op_chat_turn_wrapup_later";
    writeOp({ ...baseOp(later, OP_TYPE.chatTurn), sessionId: earlier._sessionId, status: "running", createdAt: new Date().toISOString() });
    const r = await wrapUpTool.execute({ recap: "It is 3pm.", _sessionId: earlier._sessionId, _operationId: later });
    expect(r.isError).toBeFalsy();
  });

  it("does not push a request the user told to change nothing", async () => {
    const t = turn();
    setOpLedger(t._operationId, { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't change anything"] });
    await plan.execute({ items, ...t });
    expect((await wrapUpTool.execute({ recap: "Read it.", ...t })).isError).toBeFalsy();
    clearOpLedger(t._operationId);
  });

  describe("with background work this chat started still running", () => {
    function handOff(t: { _sessionId: string }, status: "running" | "completed"): string {
      const id = `op_install_${++n}`;
      writeOp({ ...baseOp(id, "android_preview_verify"), sessionId: t._sessionId, status, createdAt: new Date().toISOString() });
      trackOpForSession(id, t._sessionId);
      return id;
    }

    it("closes without a push, and the step that was handed off stays in progress", async () => {
      const t = turn();
      await plan.execute({ items, ...t });
      const worker = handOff(t, "running");
      const r = await wrapUpTool.execute({ recap: "A worker is on it.", ...t });
      expect(r.isError).toBeFalsy();
      expect(statuses(r)).toEqual(["in_progress", "pending", "pending"]);
      releaseOpFromSession(worker);
    });

    it("ticks a step the chat started itself after the hand-off", async () => {
      const t = turn();
      await plan.execute({ items, ...t });
      const worker = handOff(t, "running");
      await new Promise((r) => setTimeout(r, 5));
      await plan.execute({ advance: true, ...t });
      const r = await wrapUpTool.execute({ recap: "Changed it; the worker is still testing.", ...t });
      expect(statuses(r)).toEqual(["completed", "completed", "pending"]);
      releaseOpFromSession(worker);
    });

    it("work that has ended is not waited for", async () => {
      const t = turn();
      await plan.execute({ items, ...t });
      const worker = handOff(t, "completed");
      expect((await wrapUpTool.execute({ recap: "Read it.", ...t })).isError).toBe(true);
      releaseOpFromSession(worker);
    });
  });
});

describe("isLedgerTool: the agent's own step list, read from the row's tasks tag", () => {
  it("counts the task tools, update_plan and wrap_up, and no unregistered task_* name", () => {
    for (const name of ["task_create", "task_update", "task_list", "task_get", "update_plan", "wrap_up"]) expect(isLedgerTool(name)).toBe(true);
    expect(isLedgerTool("task_from_a_plugin")).toBe(false);
    expect(isLedgerTool("edit")).toBe(false);
  });
});

describe("the prompt's step-list guidance", () => {
  // The system prompt carries every task tool's steer (Tool Best Practices).
  // Two tools both told "use for multi-step work" leave a model choosing
  // between them, and only update_plan is in a capped local model's set.
  it("sends a multi-step plan to update_plan alone", async () => {
    const { promptOf } = await import("../tool-registry.js");
    expect(promptOf("update_plan")).toMatch(/several steps/);
    expect(promptOf("task_create")).toMatch(/update_plan instead/);
  });
});

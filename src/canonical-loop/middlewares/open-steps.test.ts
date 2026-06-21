import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";

vi.mock("../../ops/session-bridge.js", () => ({
  getSessionForOp: vi.fn(),
}));
vi.mock("../../tools/task-tools.js", () => ({
  getOpenTasksForSession: vi.fn(),
}));
vi.mock("../store.js", () => ({
  readOpTurns: vi.fn(() => []),
}));

import {
  openStepsMiddleware,
  openStepsTerminationWarning,
  earnedDoneNudge,
  clearEarnedDoneStateForOp,
  _resetEarnedDoneState,
} from "./open-steps.js";
import type { Op } from "../../ops/types.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { getOpenTasksForSession } from "../../tools/task-tools.js";
import { readOpTurns } from "../store.js";

const mockSession = vi.mocked(getSessionForOp);
const mockOpenTasks = vi.mocked(getOpenTasksForSession);
const mockOpTurns = vi.mocked(readOpTurns);

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-${opCounter++}`, lane: "agent" },
    turnIdx: 0,
    toolCalls: [],
    toolNames: new Set(["task_create", "task_update"]),
    assistantContent: "Here's the result.",
    ...over,
  } as unknown as CanonicalLoopContext;
}

async function fire(c: CanonicalLoopContext) {
  return openStepsMiddleware.afterModelCall!(c);
}

describe("open-steps gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockReturnValue("sess-default");
  });

  it("continues when the turn still requested tools", async () => {
    expect((await fire(ctx({ toolCalls: [{} as never] }))).kind).toBe("continue");
    expect(mockOpenTasks).not.toHaveBeenCalled();
  });

  it("continues when the model produced no answer text", async () => {
    expect((await fire(ctx({ assistantContent: "   " }))).kind).toBe("continue");
    expect(mockOpenTasks).not.toHaveBeenCalled();
  });

  it("continues when the op has no resolvable session", async () => {
    mockSession.mockReturnValue(undefined);
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("continues when the session has no open tasks", async () => {
    mockOpenTasks.mockReturnValue([]);
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("nudges with the remaining steps named when tasks are left open", async () => {
    mockSession.mockReturnValue("sess-a");
    mockOpenTasks.mockReturnValue([
      { id: "1", description: "Write the parser" },
      { id: "2", description: "Add tests" },
    ]);
    const res = await fire(ctx());
    expect(res.kind).toBe("nudge");
    if (res.kind !== "nudge") throw new Error("unreachable");
    expect(res.reason).toBe("open-steps");
    expect(res.message).toContain("2 steps");
    expect(res.message).toContain("Write the parser");
    expect(res.message).toContain("Add tests");
  });

  it("does not re-nudge the same open set twice (no-progress guard)", async () => {
    mockSession.mockReturnValue("sess-b");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Step one" }]);
    expect((await fire(ctx())).kind).toBe("nudge");
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("nudges again once the open set changes (progress was made)", async () => {
    mockSession.mockReturnValue("sess-c");
    mockOpenTasks.mockReturnValue([
      { id: "1", description: "Step one" },
      { id: "2", description: "Step two" },
    ]);
    expect((await fire(ctx())).kind).toBe("nudge");
    mockOpenTasks.mockReturnValue([{ id: "2", description: "Step two" }]);
    expect((await fire(ctx())).kind).toBe("nudge");
  });
});

describe("turn-0 plan seed (beforeTurn)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockReturnValue("sess-seed");
    mockOpenTasks.mockReturnValue([]);
  });

  async function seed(c: CanonicalLoopContext) {
    return openStepsMiddleware.beforeTurn!(c);
  }

  it("seeds the plan instruction on turn 0 of a worker op", async () => {
    const res = await seed(ctx({ turnIdx: 0 }));
    expect(res.kind).toBe("nudge");
    if (res.kind !== "nudge") throw new Error("unreachable");
    expect(res.reason).toBe("open-steps-seed");
    expect(res.message).toContain("task_create");
  });

  it("fires for the background lane too (cron missions)", async () => {
    expect((await seed(ctx({ op: { id: "op-bg", lane: "background" } as never }))).kind).toBe("nudge");
  });

  it("skips turns after the first", async () => {
    expect((await seed(ctx({ turnIdx: 1 }))).kind).toBe("continue");
  });

  it("skips interactive and build lanes", async () => {
    expect((await seed(ctx({ op: { id: "op-i", lane: "interactive" } as never }))).kind).toBe("continue");
    expect((await seed(ctx({ op: { id: "op-b", lane: "build" } as never }))).kind).toBe("continue");
  });

  it("skips when task tools aren't advertised to this op", async () => {
    expect((await seed(ctx({ toolNames: new Set(["read"]) }))).kind).toBe("continue");
  });

  it("skips when the session already has open tasks", async () => {
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Existing plan" }]);
    expect((await seed(ctx())).kind).toBe("continue");
  });
});

describe("openStepsTerminationWarning", () => {
  const okTaskTurn = [{ toolCallSummary: [{ tool: "task_create", resultStatus: "ok" }] }] as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockReturnValue("sess-warn");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Finish the report" }]);
    mockOpTurns.mockReturnValue(okTaskTurn);
  });

  it("returns the warning when the op used task tools and steps remain open", () => {
    const w = openStepsTerminationWarning("op-w");
    expect(w).toContain("1 step still open");
    expect(w).toContain("Finish the report");
  });

  it("stays under 200 chars so it can never displace a mission report", () => {
    mockOpenTasks.mockReturnValue(
      Array.from({ length: 8 }, (_, i) => ({ id: String(i), description: `A very long step description number ${i} with lots of words` })),
    );
    const w = openStepsTerminationWarning("op-w");
    expect(w).not.toBeNull();
    expect(w!.length).toBeLessThan(200);
  });

  it("is null when this op never touched the task tools", () => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [{ tool: "read", resultStatus: "ok" }] }] as never);
    expect(openStepsTerminationWarning("op-w")).toBeNull();
  });

  it("does not count failed task-tool calls as touching the list", () => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [{ tool: "task_create", resultStatus: "error" }] }] as never);
    expect(openStepsTerminationWarning("op-w")).toBeNull();
  });

  it("is null with no open steps or no session", () => {
    mockOpenTasks.mockReturnValue([]);
    expect(openStepsTerminationWarning("op-w")).toBeNull();
    mockOpenTasks.mockReturnValue([{ id: "1", description: "x" }]);
    mockSession.mockReturnValue(undefined);
    expect(openStepsTerminationWarning("op-w")).toBeNull();
  });
});

describe("earnedDoneNudge — unattended earned-done gate", () => {
  const okTaskTurn = [{ toolCallSummary: [{ tool: "task_create", resultStatus: "ok" }] }] as never;
  const op = (id: string, lane: Op["lane"]): Op => ({ id, lane } as unknown as Op);

  beforeEach(() => {
    vi.clearAllMocks();
    _resetEarnedDoneState();
    mockSession.mockReturnValue("sess-earned");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Wire the export endpoint" }]);
    mockOpTurns.mockReturnValue(okTaskTurn);
  });

  it("forces one more turn for a worker op with an open step, then terminates", () => {
    // First pass: open step + the model said done → nudge to finish-or-justify.
    const first = earnedDoneNudge(op("op-worker", "agent"));
    expect(first).not.toBeNull();
    expect(first).toContain("Wire the export endpoint");
    expect(first).toContain("unattended");
    // Second pass for the SAME op: bounded to one fire → null, so the op ends.
    expect(earnedDoneNudge(op("op-worker", "agent"))).toBeNull();
  });

  it("fires for background and build lanes (also unattended)", () => {
    expect(earnedDoneNudge(op("op-bg", "background"))).not.toBeNull();
    expect(earnedDoneNudge(op("op-build", "build"))).not.toBeNull();
  });

  it("never fires on the interactive chat lane", () => {
    expect(earnedDoneNudge(op("op-chat", "interactive"))).toBeNull();
  });

  it("is null when there are no open steps", () => {
    mockOpenTasks.mockReturnValue([]);
    expect(earnedDoneNudge(op("op-clean", "agent"))).toBeNull();
  });

  it("is null when this op never worked the task list", () => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [{ tool: "read", resultStatus: "ok" }] }] as never);
    expect(earnedDoneNudge(op("op-notouch", "agent"))).toBeNull();
  });

  it("can fire again after the op's state is cleared on terminal", () => {
    expect(earnedDoneNudge(op("op-recycle", "agent"))).not.toBeNull();
    expect(earnedDoneNudge(op("op-recycle", "agent"))).toBeNull();
    clearEarnedDoneStateForOp("op-recycle");
    expect(earnedDoneNudge(op("op-recycle", "agent"))).not.toBeNull();
  });
});

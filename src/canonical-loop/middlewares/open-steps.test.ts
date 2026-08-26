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
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";

const mockSession = vi.mocked(getSessionForOp);
const mockOpenTasks = vi.mocked(getOpenTasksForSession);
const mockOpTurns = vi.mocked(readOpTurns);

/** An op that planned AND did real work. The gates require committed work
 *  beyond the task ledger, so a ledger-only fixture would assert the bug. */
const OK_WORK_TURN = [{ toolCallSummary: [
  { tool: "task_create", resultStatus: "ok" },
  { tool: "write", resultStatus: "ok" },
] }] as never;

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
    mockOpTurns.mockReturnValue(OK_WORK_TURN);
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

describe("interactive build plan-seed (reactive, afterModelCall)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockReturnValue("sess-ibs");
    mockOpenTasks.mockReturnValue([]); // no declared plan → reach the reactive seed
  });

  function ictx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
    return ctx({
      op: { id: `ibs-${opCounter++}`, lane: "interactive" } as never,
      committingToolsThisOp: new Set(["write"]),
      ...over,
    });
  }

  it("seeds a plan-and-verify nudge when an interactive turn wrote files but declared done with no plan", async () => {
    const res = await fire(ictx());
    expect(res.kind).toBe("nudge");
    if (res.kind !== "nudge") throw new Error("unreachable");
    expect(res.reason).toBe("interactive-build-seed");
    expect(res.message).toContain("task_create");
    expect(res.message).toContain("verify");
  });

  it("does NOT fire on a pure chat answer that committed nothing (behaves exactly as today)", async () => {
    const res = await fire(ictx({ committingToolsThisOp: new Set() }));
    expect(res.kind).toBe("continue");
  });

  it("keys on file writes only — a non-file commit (e.g. scheduling) does not trip it", async () => {
    const res = await fire(ictx({ committingToolsThisOp: new Set(["schedule_task"]) }));
    expect(res.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const c = ictx();
    expect((await fire(c)).kind).toBe("nudge");
    expect((await fire(c)).kind).toBe("continue");
  });

  it("never fires on worker lanes — they get the beforeTurn seed + earned-done instead", async () => {
    expect((await fire(ictx({ op: { id: "ibs-agent", lane: "agent" } as never }))).kind).toBe("continue");
    expect((await fire(ictx({ op: { id: "ibs-bg", lane: "background" } as never }))).kind).toBe("continue");
  });

  it("does not fire when task_create isn't advertised to the op", async () => {
    const res = await fire(ictx({ toolNames: new Set(["write"]) }));
    expect(res.kind).toBe("continue");
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
  const op = (id: string, lane: Op["lane"]): Op => ({ id, lane } as unknown as Op);

  beforeEach(() => {
    vi.clearAllMocks();
    _resetEarnedDoneState();
    mockSession.mockReturnValue("sess-earned");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Wire the export endpoint" }]);
    mockOpTurns.mockReturnValue(OK_WORK_TURN);
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

describe("instruction-ledger gating (user forbade workspace writes)", () => {

  function forbidWrites(opId: string): void {
    setOpLedger(opId, { prohibitions: ["workspace-write"], obligations: [], phrases: ["read-only"] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetEarnedDoneState();
    _resetOpLedgers();
    mockSession.mockReturnValue("sess-ledger");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Step one" }]);
    mockOpTurns.mockReturnValue(OK_WORK_TURN);
  });

  it("`when` suppresses both hooks when workspace-write is forbidden; fail-open without a ledger", () => {
    const c = ctx();
    expect(openStepsMiddleware.when!(c)).toBe(true); // no ledger → run normally
    forbidWrites(c.op.id);
    expect(openStepsMiddleware.when!(c)).toBe(false);
  });

  it("earnedDoneNudge is null when workspace-write is forbidden, fires without", () => {
    forbidWrites("op-ed-forbid");
    expect(earnedDoneNudge({ id: "op-ed-forbid", lane: "agent" } as unknown as Op)).toBeNull();
    expect(earnedDoneNudge({ id: "op-ed-free", lane: "agent" } as unknown as Op)).not.toBeNull();
  });

  it("openStepsTerminationWarning is null when workspace-write is forbidden, warns without", () => {
    forbidWrites("op-warn-forbid");
    expect(openStepsTerminationWarning("op-warn-forbid")).toBeNull();
    expect(openStepsTerminationWarning("op-warn-free")).not.toBeNull();
  });
});

describe("read-only ops never buy an extra turn", () => {
  // The shape that regressed: three planning calls, two PDF reads, an answer.
  // Both PDFs and the task ledger carry risk "workspace-write" in the registry,
  // so a name-only committing check credits all five as work and forces a turn
  // whose entire output is task_update x3.
  const CONTRACTS_TURN = [{ toolCallSummary: [
    { tool: "task_create", resultStatus: "ok" },
    { tool: "task_create", resultStatus: "ok" },
    { tool: "task_create", resultStatus: "ok" },
    { tool: "pdf", resultStatus: "ok" },
    { tool: "pdf", resultStatus: "ok" },
  ] }] as never;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetEarnedDoneState();
    _resetOpLedgers();
    mockSession.mockReturnValue("sess-readonly");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Summarize the amendment" }]);
    mockOpTurns.mockReturnValue(CONTRACTS_TURN);
  });

  it("does not force a continuation after reading documents", async () => {
    expect((await fire(ctx({ op: { id: "op-contracts", lane: "interactive" } as never }))).kind)
      .toBe("continue");
  });

  it("does not force a continuation for a ledger-only op", async () => {
    mockOpTurns.mockReturnValue(
      [{ toolCallSummary: [{ tool: "task_create", resultStatus: "ok" }] }] as never,
    );
    expect((await fire(ctx())).kind).toBe("continue");
  });

  it("earnedDoneNudge stays silent for a read-only unattended run", () => {
    expect(earnedDoneNudge({ id: "op-research", lane: "agent" } as never)).toBeNull();
  });

  it("still fires once the op writes something", async () => {
    mockOpTurns.mockReturnValue(OK_WORK_TURN);
    expect((await fire(ctx())).kind).toBe("nudge");
  });

  it("does not burn the one-shot nudge slot on the suppressed turn", async () => {
    mockSession.mockReturnValue("sess-slot");
    const first = await fire(ctx());
    expect(first.kind).toBe("continue");
    mockOpTurns.mockReturnValue(OK_WORK_TURN);
    expect((await fire(ctx())).kind).toBe("nudge");
  });
});

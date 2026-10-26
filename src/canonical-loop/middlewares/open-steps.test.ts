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
  endsWithOpenSteps,
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
import { makeCanonicalLoopContext, type CanonicalLoopContextOverrides } from "./ctx.test-helper.js";
import { getMiddlewareState } from "./state.js";
import { createVerifyGateState, noteVerifyEvidence, type VerifyGateState } from "../../agent-guards/index.js";

const mockSession = vi.mocked(getSessionForOp);
const mockOpenTasks = vi.mocked(getOpenTasksForSession);
const mockOpTurns = vi.mocked(readOpTurns);

/** An op that planned AND did real work. Read from op_turns by the two
 *  decide-outcome entry points, which have no ctx. */
const OK_WORK_TURN = [{ toolCallSummary: [
  { tool: "task_create", resultStatus: "ok" },
  { tool: "write", resultStatus: "ok" },
] }] as never;

let opCounter = 0;
// The hooks read the host-precomputed substantive set, never op_turns.
function ctx(over: CanonicalLoopContextOverrides = {}): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: `op-${opCounter++}`, lane: "agent" },
    turnIdx: 0,
    toolCalls: [],
    toolNames: new Set(["task_create", "task_update"]),
    assistantContent: "Here's the result.",
    substantiveCommittingToolsThisOp: new Set(["write"]),
    ...over,
  });
}

/** An op that opened the steps: it worked the task list (as OK_WORK_TURN). */
const worked = (over: CanonicalLoopContextOverrides = {}) => ctx({ toolsCalledThisOp: new Set(["task_create", "write"]), ...over });

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
    expect((await fire(worked())).kind).toBe("continue");
  });

  it("continues when the session has no open tasks", async () => {
    mockOpenTasks.mockReturnValue([]);
    expect((await fire(worked())).kind).toBe("continue");
  });

  it("nudges with the remaining steps named when tasks are left open", async () => {
    mockSession.mockReturnValue("sess-a");
    mockOpenTasks.mockReturnValue([
      { id: "1", description: "Write the parser" },
      { id: "2", description: "Add tests" },
    ]);
    const res = await fire(worked());
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
    expect((await fire(worked())).kind).toBe("nudge");
    expect((await fire(worked())).kind).toBe("continue");
  });

  it("nudges again once the open set changes (progress was made)", async () => {
    mockSession.mockReturnValue("sess-c");
    mockOpenTasks.mockReturnValue([
      { id: "1", description: "Step one" },
      { id: "2", description: "Step two" },
    ]);
    expect((await fire(worked())).kind).toBe("nudge");
    mockOpenTasks.mockReturnValue([{ id: "2", description: "Step two" }]);
    expect((await fire(worked())).kind).toBe("nudge");
  });

  // Live 2026-10-26: a plan was handed off to a code session, its steps left open;
  // the next, unrelated request did real work and was told "4 steps still
  // open… continue with the next step now".
  it("leaves steps an earlier request opened to that request: an op that never worked the list is not pushed", async () => {
    mockSession.mockReturnValue("sess-parked");
    mockOpenTasks.mockReturnValue([{ id: "tcl-planner", description: "Build the week grid" }]);
    expect((await fire(ctx({ toolsCalledThisOp: new Set(["protocol", "bash"]) }))).kind).toBe("continue");
    expect((await fire(ctx({ toolsCalledThisOp: new Set(["protocol", "task_update"]) }))).kind).toBe("nudge");
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
    expect((await seed(ctx({ op: { id: "op-bg", lane: "background" } }))).kind).toBe("nudge");
  });

  it("skips turns after the first", async () => {
    expect((await seed(ctx({ turnIdx: 1 }))).kind).toBe("continue");
  });

  it("skips interactive and build lanes", async () => {
    expect((await seed(ctx({ op: { id: "op-i", lane: "interactive" } }))).kind).toBe("continue");
    expect((await seed(ctx({ op: { id: "op-b", lane: "build" } }))).kind).toBe("continue");
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

  function ictx(over: CanonicalLoopContextOverrides = {}): CanonicalLoopContext {
    return ctx({
      op: { id: `ibs-${opCounter++}`, lane: "interactive" },
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
    expect((await fire(ictx({ op: { id: "ibs-agent", lane: "agent" } }))).kind).toBe("continue");
    expect((await fire(ictx({ op: { id: "ibs-bg", lane: "background" } }))).kind).toBe("continue");
  });

  it("does not fire when task_create isn't advertised to the op", async () => {
    const res = await fire(ictx({ toolNames: new Set(["write"]) }));
    expect(res.kind).toBe("continue");
  });

  // chat-mvfaq00w, 2026-10-21: three steps created and completed, then
  // "no plan on record", and the model repeated its whole report.
  it("does not fire when this op laid out a plan and finished it — no open steps is how a done plan looks", async () => {
    const res = await fire(ictx({ toolsCalledThisOp: new Set(["write", "task_create", "task_update"]) }));
    expect(res.kind).toBe("continue");
  });

  // The 2026-10-24 Aider run: every exercise was pushed here after the model had
  // run its solution, and answered by repeating its report.
  it("does not fire when a check passed after the last edit, and does while the edit is unchecked", async () => {
    const checked = ictx();
    noteVerifyEvidence([
      { tool: "write", writes: ["grade_school.py"], status: "ok" },
      { tool: "bash", command: `python -c "from grade_school import School; print(School().roster())"`, status: "ok" },
    ], getMiddlewareState<VerifyGateState>(checked.op.id, "verify-gate", createVerifyGateState));
    expect((await fire(checked)).kind).toBe("continue");

    const unchecked = ictx();
    noteVerifyEvidence([{ tool: "write", writes: ["grade_school.py"], status: "ok" }],
      getMiddlewareState<VerifyGateState>(unchecked.op.id, "verify-gate", createVerifyGateState));
    expect((await fire(unchecked)).kind).toBe("nudge");
  });
});

describe("endsWithOpenSteps", () => {
  const okTaskTurn = [{ toolCallSummary: [{ tool: "task_create", resultStatus: "ok" }] }] as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.mockReturnValue("sess-warn");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Finish the report" }]);
    mockOpTurns.mockReturnValue(okTaskTurn);
  });

  it("is true when the op used task tools and steps remain open", () => {
    expect(endsWithOpenSteps("op-w")).toBe(true);
  });

  it("is false when this op never touched the task tools", () => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [{ tool: "read", resultStatus: "ok" }] }] as never);
    expect(endsWithOpenSteps("op-w")).toBe(false);
  });

  it("does not count failed task-tool calls as touching the list", () => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [{ tool: "task_create", resultStatus: "error" }] }] as never);
    expect(endsWithOpenSteps("op-w")).toBe(false);
  });

  it("is false with no open steps or no session", () => {
    mockOpenTasks.mockReturnValue([]);
    expect(endsWithOpenSteps("op-w")).toBe(false);
    mockOpenTasks.mockReturnValue([{ id: "1", description: "x" }]);
    mockSession.mockReturnValue(undefined);
    expect(endsWithOpenSteps("op-w")).toBe(false);
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

  it("endsWithOpenSteps is false when workspace-write is forbidden, true without", () => {
    forbidWrites("op-warn-forbid");
    expect(endsWithOpenSteps("op-warn-forbid")).toBe(false);
    expect(endsWithOpenSteps("op-warn-free")).toBe(true);
  });
});

describe("read-only ops never buy an extra turn", () => {
  // The shape that regressed: 3 planning calls + 2 PDF reads, all of them risk
  // "workspace-write", so a name-only check credits five no-ops as work.
  const CONTRACTS_TURN = [{ toolCallSummary:
    ["task_create", "task_create", "task_create", "pdf", "pdf"]
      .map((tool) => ({ tool, resultStatus: "ok" })) }] as never;

  // The hook's view of that op: nothing substantive on record.
  const readOnly = (over: CanonicalLoopContextOverrides = {}) =>
    ctx({ substantiveCommittingToolsThisOp: new Set<string>(), ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetEarnedDoneState();
    _resetOpLedgers();
    mockSession.mockReturnValue("sess-readonly");
    mockOpenTasks.mockReturnValue([{ id: "1", description: "Summarize the amendment" }]);
    mockOpTurns.mockReturnValue(CONTRACTS_TURN);
  });

  it("does not force a continuation after reading documents", async () => {
    const c = readOnly({ op: { id: "op-contracts", lane: "interactive" } });
    expect((await fire(c)).kind).toBe("continue");
  });

  it("does not force a continuation for a ledger-only op", async () => {
    expect((await fire(readOnly())).kind).toBe("continue");
  });

  it("earnedDoneNudge stays silent for it, and the hook fires once work lands", async () => {
    expect(earnedDoneNudge({ id: "op-research", lane: "agent" } as never)).toBeNull();
    expect((await fire(worked())).kind).toBe("nudge");
  });

  it("does not burn the one-shot nudge slot on the suppressed turn", async () => {
    mockSession.mockReturnValue("sess-slot");
    expect((await fire(readOnly())).kind).toBe("continue");
    expect((await fire(worked())).kind).toBe("nudge");
  });

  it("the hook never re-reads op_turns — host already walked them", async () => {
    await fire(readOnly());
    await fire(ctx());
    expect(mockOpTurns).not.toHaveBeenCalled();
  });

  // earnedDoneNudge still walks op_turns itself (no ctx at decide-outcome) —
  // the end-to-end proof that the STORED verdict, not the name, decides.
  it.each([
    ["a pdf CREATE", { committing: true }, true],
    ["the pdf READ sharing its name", { committing: false }, false],
    ["a create the policy BLOCKED", { resultStatus: "blocked", committing: true }, false],
    ["a legacy row carrying no verdict", {}, false],
  ])("earnedDoneNudge on %s → fires: %s", (label, row, fires) => {
    mockOpTurns.mockReturnValue([{ toolCallSummary: [
      { tool: "task_create", resultStatus: "ok" },
      { tool: "pdf", resultStatus: "ok", ...row },
    ] }] as never);
    expect(earnedDoneNudge({ id: `op-${label}`, lane: "agent" } as never) !== null).toBe(fires);
  });
});

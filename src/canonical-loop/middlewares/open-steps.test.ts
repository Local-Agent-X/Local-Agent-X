import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CanonicalLoopContext } from "./types.js";

vi.mock("../../ops/session-bridge.js", () => ({
  getSessionForOp: vi.fn(),
}));
vi.mock("../../tools/task-tools.js", () => ({
  getOpenTasksForSession: vi.fn(),
}));

import { openStepsMiddleware } from "./open-steps.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { getOpenTasksForSession } from "../../tools/task-tools.js";

const mockSession = vi.mocked(getSessionForOp);
const mockOpenTasks = vi.mocked(getOpenTasksForSession);

let opCounter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `op-${opCounter++}` },
    toolCalls: [],
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

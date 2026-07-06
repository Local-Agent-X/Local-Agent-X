/**
 * Behavior tests for the self-check middleware: on a terminal-shaped turn it
 * scans the op's message history (readOpMessages — mocked at the store seam)
 * for unresolved tool errors and injects a [Self-check] reflection prompt.
 * Wraps agent-guards/reflection.ts. The when-gate (worker lanes only) is
 * covered in worker-op-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { selfCheckMiddleware } from "./self-check.js";
import { _resetMiddlewareStates } from "./state.js";
import { readOpMessages } from "../store.js";
import type { CanonicalLoopContext } from "./types.js";

vi.mock("../store.js", () => ({ readOpMessages: vi.fn(() => []) }));
const mockRead = vi.mocked(readOpMessages);

let _op = 0;
const opId = () => `op-sc-test-${++_op}`;

// Minimal op_message rows in the shapes self-check projects:
// assistant/user rows carry {text}, tool_result rows carry {toolCallId, result}.
const asst = (text: string) => ({ role: "assistant", content: { text } });
const user = (text: string) => ({ role: "user", content: { text } });
const toolRes = (result: string, toolCallId = "t1") =>
  ({ role: "tool_result", content: { toolCallId, result } });

const ENOENT = "Error: ENOENT: no such file or directory, open 'config.json'";

function ctxFor(op: string, over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    assistantContent: "All set — the migration is complete.",
    toolCalls: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

const run = (c: CanonicalLoopContext) => selfCheckMiddleware.afterModelCall!(c);

beforeEach(() => {
  _resetMiddlewareStates();
  mockRead.mockReset().mockReturnValue([]);
});

describe("self-check middleware", () => {
  it("nudges a terminal turn when the prior turn left an unresolved tool error", async () => {
    mockRead.mockReturnValue([asst("Running the migration now."), toolRes(ENOENT)] as never);
    const r = await run(ctxFor(opId()));
    expect(r).toMatchObject({ kind: "nudge", reason: "self-check" });
    if (r.kind === "nudge") {
      expect(r.message).toContain("[Self-check]");
      expect(r.message).toContain("ENOENT");
    }
  });

  it("stays quiet while the model is still calling tools this turn", async () => {
    mockRead.mockReturnValue([asst("working"), toolRes(ENOENT)] as never);
    const r = await run(ctxFor(opId(), {
      toolCalls: [{ toolCallId: "x", tool: "read", args: {} }] as never,
    }));
    expect(r.kind).toBe("continue");
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("stays quiet when the last assistant text already acknowledged the failure", async () => {
    mockRead.mockReturnValue([
      asst("The migration failed with ENOENT — I tried a workaround and moved on."),
      toolRes(ENOENT),
    ] as never);
    expect((await run(ctxFor(opId()))).kind).toBe("continue");
  });

  it("does not re-raise errors the model already responded to (assistant text after the error)", async () => {
    mockRead.mockReturnValue([toolRes(ENOENT), asst("Recovered by regenerating config.json.")] as never);
    expect((await run(ctxFor(opId()))).kind).toBe("continue");
  });

  it("does not double-nudge when a [Self-check] is already in the recent window", async () => {
    mockRead.mockReturnValue([
      asst("Running the migration now."),
      toolRes(ENOENT),
      user("[Self-check] The following tool errors occurred..."),
    ] as never);
    expect((await run(ctxFor(opId()))).kind).toBe("continue");
  });

  it("stays quiet on clean tool results", async () => {
    mockRead.mockReturnValue([asst("Listing files."), toolRes("src/a.ts\nsrc/b.ts")] as never);
    expect((await run(ctxFor(opId()))).kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    const op = opId();
    mockRead.mockReturnValue([asst("Running the migration now."), toolRes(ENOENT)] as never);
    expect((await run(ctxFor(op))).kind).toBe("nudge");
    expect((await run(ctxFor(op))).kind).toBe("continue");
  });
});

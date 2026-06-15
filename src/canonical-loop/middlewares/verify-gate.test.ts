import { describe, it, expect } from "vitest";
import { verifyGateMiddleware } from "./verify-gate.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-vg-test-${++_op}`; }

function ctxFor(
  op: string,
  over: Partial<CanonicalLoopContext>,
): CanonicalLoopContext {
  return {
    op: { id: op, lane: "agent" },
    turnIdx: 1,
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    committingToolsThisOp: new Set<string>(),
    evidenceHistory: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

function editTurn(op: string, file: string) {
  return verifyGateMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "e1", tool: "edit", args: { file_path: file } }],
      toolResults: [{ toolCallId: "e1", toolName: "edit", content: "ok", status: "ok" }],
    } as Partial<CanonicalLoopContext>),
  );
}

function bashTurn(op: string, command: string) {
  return verifyGateMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "b1", tool: "bash", args: { command } }],
      toolResults: [{ toolCallId: "b1", toolName: "bash", content: "done", status: "ok" }],
    } as Partial<CanonicalLoopContext>),
  );
}

function wrapUp(op: string) {
  return verifyGateMiddleware.afterModelCall!(
    ctxFor(op, { toolCalls: [], assistantContent: "All done — refactored the parser." }),
  );
}

describe("verify-gate", () => {
  it("nudges once when a worker edits source then wraps up without verifying", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "src/parser.ts");
    const r = await wrapUp(op);
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("verify-gate");
  });

  it("does NOT nudge when a build ran after the source edit", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "src/parser.ts");
    await bashTurn(op, "npm run build");
    const r = await wrapUp(op);
    expect(r.kind).toBe("continue");
  });

  it("re-arms when a new edit lands after a verified build", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "src/parser.ts");
    await bashTurn(op, "npm test");
    await editTurn(op, "src/parser.ts"); // invalidates the prior verify
    const r = await wrapUp(op);
    expect(r.kind).toBe("nudge");
  });

  it("ignores non-source edits (docs/config only)", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "README.md");
    await editTurn(op, "package.json");
    const r = await wrapUp(op);
    expect(r.kind).toBe("continue");
  });

  it("does not nudge when the wrap-up turn still has tool calls", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "src/parser.ts");
    const r = await verifyGateMiddleware.afterModelCall!(
      ctxFor(op, {
        toolCalls: [{ toolCallId: "x", tool: "read", args: {} }],
        assistantContent: "checking one more thing",
      } as Partial<CanonicalLoopContext>),
    );
    expect(r.kind).toBe("continue");
  });

  it("fires at most once per op", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await editTurn(op, "src/parser.ts");
    expect((await wrapUp(op)).kind).toBe("nudge");
    expect((await wrapUp(op)).kind).toBe("continue");
  });

  it("is gated to worker ops", () => {
    expect(verifyGateMiddleware.when!(
      { op: { id: "x", lane: "interactive" } } as unknown as CanonicalLoopContext,
    )).toBe(false);
    expect(verifyGateMiddleware.when!(
      { op: { id: "x", lane: "agent" } } as unknown as CanonicalLoopContext,
    )).toBe(true);
  });
});

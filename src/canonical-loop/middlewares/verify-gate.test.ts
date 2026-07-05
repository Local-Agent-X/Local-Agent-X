import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the LLM judge BEFORE importing the middleware so the deleted-test path is
// deterministic (no provider call). The verdict is injected per test.
type ClassifyTestDeletion = typeof import("../../classifiers/test-deletion-classify.js").classifyTestDeletion;
const classifyTestDeletionMock = vi.fn<ClassifyTestDeletion>();
vi.mock("../../classifiers/test-deletion-classify.js", () => ({
  classifyTestDeletion: (...args: Parameters<ClassifyTestDeletion>) => classifyTestDeletionMock(...args),
}));

const { verifyGateMiddleware, opDeletedTestDodge, opEditedSourceUnverified } = await import("./verify-gate.js");
const { _resetMiddlewareStates } = await import("./state.js");
import type { CanonicalLoopContext } from "./types.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import { _resetOpLedgers } from "../instruction-ledger/ledger.js";
import type { CapabilityClass } from "../../tool-registry.js";

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

function deleteTurn(op: string, file: string) {
  return verifyGateMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "d1", tool: "delete_file", args: { path: file } }],
      toolResults: [{ toolCallId: "d1", toolName: "delete_file", content: "deleted", status: "ok" }],
    } as Partial<CanonicalLoopContext>),
  );
}

function wrapUp(op: string, over: Partial<CanonicalLoopContext> = {}) {
  return verifyGateMiddleware.afterModelCall!(
    ctxFor(op, { toolCalls: [], assistantContent: "All done — refactored the parser.", ...over }),
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

  it("runs on ALL lanes (not worker-only) — a coding task often arrives as interactive chat", () => {
    // The gate deliberately has no `when` clause: an autonomous coding task
    // ("rename X→Y", "fix this bug") most often comes in as an interactive chat
    // turn, where the user trusts the "done" claim. See the module docstring.
    expect(verifyGateMiddleware.when).toBeUndefined();
  });
});

describe("verify-gate — deleted-test judge (dodge vs legit cleanup)", () => {
  // Paths that don't exist on disk, so the wrap-up "still deleted" check sees them
  // as genuinely removed. The subject guess is likewise absent → judge input says
  // the subject is gone; the mocked verdict overrides that anyway.
  const ghost = "src/__vg_ghost__.test.ts";

  beforeEach(() => classifyTestDeletionMock.mockReset());

  it("dodge verdict → nudge + demotes the outcome label", async () => {
    _resetMiddlewareStates();
    const op = opId();
    classifyTestDeletionMock.mockResolvedValue("dodge");
    await deleteTurn(op, ghost);
    const r = await wrapUp(op, { userMessage: "make the tests pass" });
    expect(r.kind).toBe("nudge");
    expect((r as { reason: string }).reason).toBe("verify-gate-test-deletion");
    expect(opDeletedTestDodge(op)).toBe(true);
  });

  it("legit-cleanup verdict → no nudge, label stays clean", async () => {
    _resetMiddlewareStates();
    const op = opId();
    classifyTestDeletionMock.mockResolvedValue("legit-cleanup");
    await deleteTurn(op, ghost);
    const r = await wrapUp(op, { userMessage: "delete the obsolete auth test" });
    expect(r.kind).toBe("continue");
    expect(opDeletedTestDodge(op)).toBe(false);
  });

  it("judge unavailable (null) → fail safe: advisory nudge, but label NOT demoted", async () => {
    _resetMiddlewareStates();
    const op = opId();
    classifyTestDeletionMock.mockResolvedValue(null);
    await deleteTurn(op, ghost);
    const r = await wrapUp(op);
    expect(r.kind).toBe("nudge");
    expect(opDeletedTestDodge(op)).toBe(false);
  });

  it("nudges at most once, but keeps the dodge label across later wrap-ups", async () => {
    _resetMiddlewareStates();
    const op = opId();
    classifyTestDeletionMock.mockResolvedValue("dodge");
    await deleteTurn(op, ghost);
    expect((await wrapUp(op)).kind).toBe("nudge");
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opDeletedTestDodge(op)).toBe(true);
  });

  it("memoizes an unchanged deletion set — one judge call across repeated wrap-ups", async () => {
    _resetMiddlewareStates();
    const op = opId();
    classifyTestDeletionMock.mockResolvedValue("dodge");
    await deleteTurn(op, ghost);
    await wrapUp(op);
    await wrapUp(op);
    expect(classifyTestDeletionMock).toHaveBeenCalledTimes(1);
  });
});

describe("verify-gate — instruction-ledger gating", () => {
  afterEach(() => _resetOpLedgers());

  function forbid(op: string, ...prohibitions: CapabilityClass[]): void {
    setOpLedger(op, { prohibitions, obligations: [], phrases: ["I'll verify myself"] });
  }

  it("suppresses the nudge when the user forbade running commands — but the label stays honest", async () => {
    _resetMiddlewareStates();
    const op = opId();
    forbid(op, "shell");
    await editTurn(op, "src/parser.ts");
    expect((await wrapUp(op)).kind).toBe("continue");
    // afterToolExecution accrual is untouched → the outcome label still demotes.
    expect(opEditedSourceUnverified(op)).toBe(true);
  });

  it("suppresses the nudge when the user forbade edits", async () => {
    _resetMiddlewareStates();
    const op = opId();
    forbid(op, "workspace-write");
    await editTurn(op, "src/parser.ts");
    expect((await wrapUp(op)).kind).toBe("continue");
  });

  it("still nudges when only an unrelated capability is forbidden (fail-open otherwise)", async () => {
    _resetMiddlewareStates();
    const op = opId();
    forbid(op, "egress");
    await editTurn(op, "src/parser.ts");
    expect((await wrapUp(op)).kind).toBe("nudge");
  });
});

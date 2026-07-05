import { describe, expect, it } from "vitest";
import type { CanonicalLoopContext } from "./types.js";
import type { InstructionLedger } from "../instruction-ledger/index.js";
import { setOpLedger } from "../instruction-ledger/index.js";
import {
  INSTRUCTION_OBLIGATION_REASON,
  INSTRUCTION_VIOLATION_REASON,
  instructionAuditMiddleware,
} from "./instruction-audit.js";

let counter = 0;
function ctx(over: Partial<CanonicalLoopContext> = {}): CanonicalLoopContext {
  return {
    op: { id: `instruction-audit-${counter++}`, type: "chat_turn", lane: "interactive" },
    turnIdx: 0,
    toolCalls: [],
    toolResults: [],
    assistantContent: "All done — the change is in place.",
    toolsCalledThisOp: new Set(),
    committingToolsThisOp: new Set(),
    attemptedToolsThisOp: new Set(),
    ...over,
  } as CanonicalLoopContext;
}

function ledger(over: Partial<InstructionLedger> = {}): InstructionLedger {
  return { prohibitions: [], obligations: [], phrases: [], ...over };
}

const commitObligation = () => ledger({
  obligations: [{ kind: "commit-when-done" }],
  phrases: ["commit when you're done"],
});

describe("instruction-audit middleware", () => {
  it("nudges at wrap-up when commit-when-done is unmet, and fires only once", async () => {
    const c = ctx();
    setOpLedger(c.op.id, commitObligation());
    const result = await instructionAuditMiddleware.afterModelCall!(c);
    expect(result).toMatchObject({
      kind: "nudge",
      reason: INSTRUCTION_OBLIGATION_REASON,
    });
    // Fire-once: the same op is not re-nudged at the next wrap-up.
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("continues when a git commit was observed this op", async () => {
    const c = ctx();
    setOpLedger(c.op.id, commitObligation());
    // A prior turn's bash result carried git's commit-success signature.
    await instructionAuditMiddleware.afterToolExecution!(ctx({
      op: c.op,
      toolResults: [{
        toolName: "bash",
        toolCallId: "call-1",
        content: "[main abc1234] ship the feature\n 2 files changed, 10 insertions(+)",
        status: "ok",
      }],
    }));
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("fails open when no ledger is set for the op", async () => {
    expect(await instructionAuditMiddleware.afterModelCall!(ctx())).toEqual({ kind: "continue" });
  });

  it("fails open when the ledger records no constraints", async () => {
    const c = ctx();
    setOpLedger(c.op.id, ledger());
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("skips non-wrap-up turns even with an unmet obligation", async () => {
    const c = ctx({
      toolCalls: [{ toolCallId: "call-1", tool: "bash", args: {} }],
    });
    setOpLedger(c.op.id, commitObligation());
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("skips empty final turns", async () => {
    const c = ctx({ assistantContent: "   " });
    setOpLedger(c.op.id, commitObligation());
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  const readFirstObligation = () => ledger({
    obligations: [{ kind: "read-before-answer" }],
    phrases: ["read parser.ts before you answer"],
  });

  it("nudges when read-before-answer is unmet (no read this op), fires once", async () => {
    const c = ctx();
    setOpLedger(c.op.id, readFirstObligation());
    const result = await instructionAuditMiddleware.afterModelCall!(c);
    expect(result).toMatchObject({ kind: "nudge", reason: INSTRUCTION_OBLIGATION_REASON });
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("continues when a read/grep/glob consulted the repo before answering", async () => {
    const c = ctx({ toolsCalledThisOp: new Set(["read"]) });
    setOpLedger(c.op.id, readFirstObligation());
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  const namedFileObligation = () => ledger({
    obligations: [{ kind: "read-before-answer", target: "parser" }],
    phrases: ["read parser.ts before you answer"],
  });

  it("target-aware: an unrelated read does NOT satisfy a named-file obligation", async () => {
    const c = ctx();
    setOpLedger(c.op.id, namedFileObligation());
    await instructionAuditMiddleware.afterToolExecution!(ctx({
      op: c.op,
      toolCalls: [{ toolCallId: "r1", tool: "read", args: { path: "src/other.ts" } }],
      toolResults: [{ toolCallId: "r1", toolName: "read", content: "…", status: "ok" }],
    }));
    const r = await instructionAuditMiddleware.afterModelCall!(c);
    expect(r).toMatchObject({ kind: "nudge", reason: INSTRUCTION_OBLIGATION_REASON });
    expect(r.kind === "nudge" ? r.message : "").toContain("parser");
  });

  it("target-aware: an OK read of the named file satisfies the obligation", async () => {
    const c = ctx();
    setOpLedger(c.op.id, namedFileObligation());
    await instructionAuditMiddleware.afterToolExecution!(ctx({
      op: c.op,
      toolCalls: [{ toolCallId: "r1", tool: "read", args: { path: "src/parser.ts" } }],
      toolResults: [{ toolCallId: "r1", toolName: "read", content: "export function…", status: "ok" }],
    }));
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("target-aware: a FAILED read of the named file does NOT satisfy it (success-only)", async () => {
    const c = ctx();
    setOpLedger(c.op.id, namedFileObligation());
    // The arg mentions parser, but the read errored (wrong path / missing file),
    // so nothing was actually consulted — it must not count.
    await instructionAuditMiddleware.afterToolExecution!(ctx({
      op: c.op,
      toolCalls: [{ toolCallId: "r1", tool: "read", args: { path: "src/parser.ts" } }],
      toolResults: [{ toolCallId: "r1", toolName: "read", content: "File not found", status: "error" }],
    }));
    const r = await instructionAuditMiddleware.afterModelCall!(c);
    expect(r).toMatchObject({ kind: "nudge", reason: INSTRUCTION_OBLIGATION_REASON });
  });

  it("target-aware: a bash cat of the named file also satisfies it", async () => {
    const c = ctx();
    setOpLedger(c.op.id, namedFileObligation());
    await instructionAuditMiddleware.afterToolExecution!(ctx({
      op: c.op,
      toolCalls: [{ toolCallId: "b1", tool: "bash", args: { command: "cat src/parser.ts" } }],
      toolResults: [{ toolCallId: "b1", toolName: "bash", content: "export function…", status: "ok" }],
    }));
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("nudges once when a forbidden capability's tool was attempted", async () => {
    const c = ctx({ attemptedToolsThisOp: new Set(["web_fetch"]) });
    setOpLedger(c.op.id, ledger({ prohibitions: ["egress"], phrases: ["no network"] }));
    const result = await instructionAuditMiddleware.afterModelCall!(c);
    expect(result).toMatchObject({
      kind: "nudge",
      reason: INSTRUCTION_VIOLATION_REASON,
    });
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("does not flag attempted tools outside the forbidden classes", async () => {
    const c = ctx({ attemptedToolsThisOp: new Set(["read", "grep"]) });
    setOpLedger(c.op.id, ledger({ prohibitions: ["egress"], phrases: ["no network"] }));
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });

  it("surfaces the violation on the wrap-up after the obligation nudge", async () => {
    const c = ctx({ attemptedToolsThisOp: new Set(["email_send"]) });
    setOpLedger(c.op.id, ledger({
      prohibitions: ["egress"],
      obligations: [{ kind: "commit-when-done" }],
      phrases: ["no network", "commit when done"],
    }));
    const first = await instructionAuditMiddleware.afterModelCall!(c);
    expect(first).toMatchObject({ kind: "nudge", reason: INSTRUCTION_OBLIGATION_REASON });
    const second = await instructionAuditMiddleware.afterModelCall!(c);
    expect(second).toMatchObject({ kind: "nudge", reason: INSTRUCTION_VIOLATION_REASON });
    expect(await instructionAuditMiddleware.afterModelCall!(c)).toEqual({ kind: "continue" });
  });
});

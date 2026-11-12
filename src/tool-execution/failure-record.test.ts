import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "./context.js";
import type { ToolResult } from "../types.js";
import { blocked, declined, err, ok, timeout } from "../tools/result-helpers.js";
import { failureSignature } from "../tools/failure-signature.js";
import { failureRecordOf } from "./failure-record.js";

function ctxWith(result: ToolResult, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    tc: { id: "call_1", name: "edit", arguments: "{}" },
    args: {},
    callContext: "local",
    operationId: "op_1",
    result,
    ...extra,
  } as unknown as ToolCallContext;
}

describe("failureRecordOf", () => {
  it("says nothing about a call that worked", () => {
    expect(failureRecordOf(ctxWith(ok("done")))).toBeUndefined();
  });

  it("records an error with its first line and where the full record is", () => {
    const record = failureRecordOf(ctxWith(err("old_string found 2 times\nin a.ts")));
    expect(record).toEqual({
      signature: failureSignature({ tool: "edit", status: "error", reason: "old_string found 2 times" }),
      reason: "old_string found 2 times",
      opId: "op_1",
      toolCallId: "call_1",
    });
  });

  it("records a timeout and a refusal, the refusal with its gate", () => {
    expect(failureRecordOf(ctxWith(timeout("no answer in 120s")))?.reason).toBe("no answer in 120s");
    const refused = failureRecordOf(ctxWith(blocked("outside the workspace", { layer: "security", recovery: "use a path inside it" })));
    expect(refused?.layer).toBe("security");
  });

  it("keys a family tool on its action", () => {
    const a = failureRecordOf(ctxWith(err("no such sheet"), { args: { action: "read" } }));
    const b = failureRecordOf(ctxWith(err("no such sheet"), { args: { action: "write" } }));
    expect(a?.signature).not.toBe(b?.signature);
  });

  it("does not count a call a person declined, or one waiting on a person", () => {
    expect(failureRecordOf(ctxWith(declined("the user said no")))).toBeUndefined();
    const parked = blocked("needs approval", { layer: "approval", recovery: "wait for the user", deferredTo: "inbox_1" });
    expect(failureRecordOf(ctxWith(parked))).toBeUndefined();
  });

  it("does not count a failure that was not produced by running the tool now", () => {
    expect(failureRecordOf(ctxWith(err("boom"), { resultReused: "dedup-cache" }))).toBeUndefined();
  });

  it("redacts the line before it is stored or keyed", () => {
    const secret = "sk-ant-api03-" + "A".repeat(90);
    const record = failureRecordOf(ctxWith(err(`401 for key ${secret}`)));
    expect(record?.reason).not.toContain(secret);
    expect(record?.signature).toBe(failureSignature({ tool: "edit", status: "error", reason: record!.reason }));
  });
});

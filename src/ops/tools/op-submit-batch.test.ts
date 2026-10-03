// Each op_submit_batch task is an object the model wrote, spread into the
// submit args. It used to carry its own `_sessionId` (and any other `_` key)
// straight through whenever the batch had no session to stamp over it, so a
// task could file its op under another conversation. These tests stop at
// buildOpFromArgs, the point where a task becomes an op, and look at what it
// was handed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SecurityLayer } from "../../security/index.js";
import { resolvePhase } from "../../tool-execution/resolve-tool.js";
import { createContext } from "../../tool-execution/context.js";

const built = vi.hoisted(() => ({ args: [] as Array<Record<string, unknown>> }));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    buildOpFromArgs: async (args: Record<string, unknown>) => {
      built.args.push(args);
      throw new Error("stopped before launch");
    },
  };
});

const { opSubmitBatchTool } = await import("./op-submit-batch.js");

const SESSION = "batch-trusted-session";
const forgedTask = (task: string, extra: Record<string, unknown> = {}) =>
  ({ task, _sessionId: "someone-else", _unsafe: true, ...extra });

async function dispatchedArgs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = createContext({
    tc: { id: "call-batch", name: "op_submit_batch", arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId: SESSION,
    callContext: "local",
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  return ctx.args;
}

beforeEach(() => { built.args = []; });

describe("op_submit_batch tasks carry the trusted session, never their own", () => {
  it("pooled tasks: the calling session replaces each task's, and other `_` keys are dropped", async () => {
    const args = await dispatchedArgs({ tasks: [forgedTask("first"), forgedTask("second")] });
    await opSubmitBatchTool.execute(args);
    expect(built.args).toEqual([
      { task: "first", _sessionId: SESSION },
      { task: "second", _sessionId: SESSION },
    ]);
  });

  it("dependency batches go through the same boundary", async () => {
    const args = await dispatchedArgs({ tasks: [forgedTask("first", { task_key: "a" }), forgedTask("second", { depends_on: ["a"] })] });
    const result = await opSubmitBatchTool.execute(args);
    expect(result.isError).toBe(true);
    expect(built.args).toEqual([{ task: "first", task_key: "a", _sessionId: SESSION }]);
  });

  it("with no session to stamp, a task's own `_sessionId` still never survives", async () => {
    await opSubmitBatchTool.execute({ tasks: [forgedTask("unattended")] });
    expect(built.args).toEqual([{ task: "unattended" }]);
  });
});

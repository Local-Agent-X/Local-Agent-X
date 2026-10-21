// Two pipelines on one session id — the MCP bridge, an inbox re-dispatch, an
// agency run with a borrowed session — each set a content-less floor for the
// same path before their reads ran. Retraction matched by (source, target)
// alone, so call A's whole-result stub withdrew call B's in-flight floor too,
// and when B's errored result then echoed the file the registry held nothing
// behind the delivered bytes (red team round 2, T-M1). A call now withdraws
// or supersedes only the floor it set itself.
import { afterEach, describe, expect, it } from "vitest";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { checkEgressTaint, clearSessionTaint, getKernelTaintSources, getTaintSummary } from "../data-lineage/index.js";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let seq = 0;
function ctxFor(tool: ToolDefinition, args: Record<string, unknown>, sessionId: string): ToolCallContext {
  seq++;
  return {
    tc: { id: `tc${seq}`, name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    tool, args, sessionId, callContext: "local", riskLevel: "low", approvalContext: "", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
}

function bashThatReturns(row: Promise<ToolResult>): ToolDefinition {
  return {
    name: "bash",
    description: "stand-in",
    parameters: { type: "object", properties: {} },
    execute: () => row,
  } as ToolDefinition;
}

const SID = "retraction-race-session";
afterEach(() => clearSessionTaint(SID));

describe("two concurrent pipelines reading one sensitive path under one session", () => {
  it("one call's stub withdraws only its own floor; the other's delivery keeps the session tainted", async () => {
    const cmd = "cat ~/.ssh/id_rsa";
    const a = deferred<ToolResult>();
    const b = deferred<ToolResult>();
    const ctxA = ctxFor(bashThatReturns(a.promise), { command: cmd }, SID);
    const ctxB = ctxFor(bashThatReturns(b.promise), { command: `${cmd}; exit 1` }, SID);

    const runA = runSandboxedPhase(ctxA);
    const runB = runSandboxedPhase(ctxB);
    expect(getTaintSummary(SID).count).toBe(2);

    // A returns cleanly: whole-result stub, A's floor withdrawn — and only A's.
    a.resolve({ content: "Host github.com\n  IdentityFile ~/.ssh/id_rsa\n  User git", isError: false });
    await runA;
    expect(ctxA.result?.metadata?.redacted).toBe(true);
    expect(getTaintSummary(SID).count).toBe(1);
    expect(checkEgressTaint(SID).blocked).toBe(true);

    // B returns an error row that echoes the file: delivered, and the floor it
    // set is still there behind the bytes.
    b.resolve({ content: "Host github.com\n  IdentityFile ~/.ssh/id_rsa\ncat: trailing garbage", isError: true, metadata: { exit_code: 1 } });
    await runB;
    expect(ctxB.result?.content).toContain("IdentityFile");
    expect(getTaintSummary(SID).count).toBe(1);
    expect(checkEgressTaint(SID).blocked).toBe(true);
    expect(getKernelTaintSources(SID)).toEqual(["rag"]);
  });

  it("a single call still clears its own floor when its result is stubbed", async () => {
    const a = deferred<ToolResult>();
    const ctxA = ctxFor(bashThatReturns(a.promise), { command: "cat ~/.ssh/id_rsa" }, SID);
    const runA = runSandboxedPhase(ctxA);
    expect(getTaintSummary(SID).count).toBe(1);
    a.resolve({ content: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", isError: false });
    await runA;
    expect(getTaintSummary(SID).count).toBe(0);
    expect(checkEgressTaint(SID).blocked).toBe(false);
  });
});

// A call an unattended run could not make without a person is parked in the
// user's inbox as an approval, from every gate that would otherwise refuse
// it, and the run goes on without it. Before this the gates refused the call
// (phase 1 posted a refused-action notice); the model was told to report it
// and the call was simply lost.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireApprovalPhase } from "./require-approval.js";
import { secretEnvGate } from "./secret-env-approval.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { deferUnattendedCall } from "./deferred-call.js";
import { executeToolCalls } from "./execute-tool.js";
import { dispatchApprovedCall } from "./approved-call.js";
import { SecurityLayer } from "../security/index.js";
import { inboxStore } from "../inbox/index.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { setAriRequired } from "../ari-kernel/state.js";
import type { CallContext, ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-deferred-call-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function ctx(name: string, args: Record<string, unknown>, callContext: CallContext, sessionId = "cron-job1-1700000000000", over: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    tc: { id: `tc-${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) },
    args, sessionId, callContext, operationId: "op_parked_1", approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
    ...over,
  } as unknown as ToolCallContext;
}

const parked = () => inboxStore().list().filter((i) => i.kind === "approval");

describe("the approval phase's unattended branch", () => {
  it("parks one needs-you approval naming the job, the tool, what it does and why; the model is told it waits there", async () => {
    const c = ctx("write", { path: "notes.md", content: "hello", _sessionId: "cron-job1-1700000000000" }, "cron", undefined, {
      policyApprovalReason: "this write needs the user's yes", callerRole: "agent",
    });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    const items = parked();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      needsYou: true, link: { sessionId: "cron-job1-1700000000000", opId: "op_parked_1" },
      actions: [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }],
    });
    expect(items[0].title).toBe("Scheduled job wants to run write");
    expect(items[0].body).toContain("Tool: write");
    expect(items[0].body).toContain("Path: notes.md");
    expect(items[0].body).toContain("Other arguments: {\"content\":\"hello\"}");
    expect(items[0].body).toContain("Why it needs you: BLOCKED (unattended): write needs human approval because this write needs the user's yes");
    expect(items[0].deferredCall).toEqual({
      toolName: "write",
      args: { path: "notes.md", content: "hello" },
      callContext: "cron",
      reason: "BLOCKED (unattended): write needs human approval because this write needs the user's yes, but no one is watching this cron run.",
      jobLabel: "Scheduled job",
      callerRole: "agent",
      cronJobId: "job1",
      sessionId: "cron-job1-1700000000000",
      opId: "op_parked_1",
    });

    const result = c.result as ToolResult;
    expect(result.status).toBe("blocked");
    expect(result.metadata).toMatchObject({ layer: "approval", deferredTo: items[0].id });
    expect(result.content).toContain("BLOCKED (unattended): write needs human approval because this write needs the user's yes");
    expect(result.content).toContain("waiting in the user's inbox");
    expect(result.content).toContain("continue the rest of the task without it");
    expect(result.content).not.toMatch(/run it from a chat|Autonomous profile/);
    expect(String(c.msgs[0]?.content)).toContain(`deferredTo="${items[0].id}"`);
    // The structured mark the loop guards read (repeat-failure.ts) rides the block record.
    expect((c.msgs[0] as { _block?: { layer: string; deferredTo?: string } })._block).toMatchObject({ layer: "approval", deferredTo: items[0].id });
  });

  it("the same scheduled job parking the same call on two runs is one item; a different call is its own", async () => {
    const run = (startedAt: number, content: string) => ctx("write", { path: "notes.md", content }, "cron", `cron-daily-${startedAt}`, {
      operationId: `op_${startedAt}`, policyApprovalReason: "needs a person",
    });
    await requireApprovalPhase(run(1700000000000, "a"));
    await requireApprovalPhase(run(1700086400000, "a"));
    expect(parked()).toHaveLength(1);
    expect(parked()[0].deferredCall).toMatchObject({ sessionId: "cron-daily-1700086400000", opId: "op_1700086400000" });
    await requireApprovalPhase(run(1700086400000, "b"));
    expect(parked()).toHaveLength(2);
  });

  it("an attended run and a headless harness run park nothing; the harness keeps the plain refusal", async () => {
    expect(deferUnattendedCall(ctx("write", { path: "x" }, "local", "s1"), "n/a")).toBeNull();
    const harness = ctx("write", { path: "x" }, "delegated", "skill-review-1-1", { policyApprovalReason: "needs a person" });
    expect((await requireApprovalPhase(harness)).kind).toBe("halt");
    expect(parked()).toHaveLength(0);
    expect(harness.result?.metadata?.deferredTo).toBeUndefined();
    expect(String(harness.result?.content)).toContain("run it from a chat");
  });
});

describe("the secret_env gate's unattended branch", () => {
  it("parks the call, secret NAMES only", async () => {
    const session = "delegated-secret-1";
    setSessionProfile(session, "Normal");
    let gate;
    try {
      const c = ctx("bash", { command: "gh release list", secret_env: { GH_TOKEN: "GITHUB_TOKEN" } }, "delegated", session);
      gate = await secretEnvGate(c);
    } finally { clearSessionProfile(session); }
    expect(gate.kind).toBe("blocked");
    const items = parked();
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain("Command: gh release list");
    expect(items[0].body).toContain("needs the user's yes under this profile");
    expect(items[0].deferredCall?.args).toEqual({ command: "gh release list", secret_env: { GH_TOKEN: "GITHUB_TOKEN" } });
    expect(gate.kind === "blocked" && gate.result.metadata?.deferredTo).toBe(items[0].id);
  });
});

describe("the unattended shell gate", () => {
  it("a cron run's shell call is parked, its own reason kept", async () => {
    const tool = { name: "bash", execute: async () => ({ content: "ran" }) } as unknown as ToolDefinition;
    const c = ctx("bash", { command: "npm test" }, "cron", undefined, { tool });
    await runSandboxedPhase(c);
    expect(String(c.result?.content)).toContain("categorically disabled for cron runs");
    expect(c.result?.status).toBe("blocked");
    expect(parked().map((i) => i.deferredCall?.toolName)).toEqual(["bash"]);
    expect(c.result?.metadata).toMatchObject({ layer: "approval", deferredTo: parked()[0].id, callContext: "cron" });
  });
});

describe("a scheduled run through the real dispatcher", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  // A Normal-profile scheduled job deleting a file: the profile asks before
  // anything destructive, and nobody is there to ask.
  it("parks the call that needs a card, still runs the next call in the same run, and the user's Approve runs it once", async () => {
    const session = "cron-digest-1700000000000";
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "old-report.md");
    writeFileSync(target, "stale");
    const security = new SecurityLayer(workspace, "workspace");
    const deleted: string[] = [];
    let listRuns = 0;
    const deleteFile = { name: "delete_file", description: "stub", parameters: { type: "object", properties: {} }, execute: async (a: Record<string, unknown>) => { deleted.push(String(a.path)); return { content: `deleted ${String(a.path)}` }; } } as unknown as ToolDefinition;
    const taskList = { name: "task_list", description: "stub", parameters: { type: "object", properties: {} }, readOnly: true, execute: async () => { listRuns++; return { content: "no tasks" }; } } as unknown as ToolDefinition;
    setSessionProfile(session, "Normal");
    try {
      const msgs = await executeToolCalls(
        [
          { id: "c1", name: "delete_file", arguments: JSON.stringify({ path: target }) },
          { id: "c2", name: "task_list", arguments: "{}" },
        ],
        new Map([["delete_file", deleteFile], ["task_list", taskList]]),
        security, undefined, undefined, undefined, undefined, session,
        undefined, undefined, undefined, undefined, "op_digest_1", "cron",
      );
      const [first, second] = msgs.filter((m) => m.role === "tool").map((m) => String(m.content));
      const item = parked()[0];
      expect(item?.deferredCall).toMatchObject({ toolName: "delete_file", args: { path: target }, cronJobId: "digest" });
      expect(item?.body).toContain(`Path: ${target}`);
      expect(first).toMatch(/^\[blocked, /);
      expect(first).toContain(`deferredTo="${item.id}"`);
      expect(deleted).toEqual([]);
      expect(second).toContain("no tasks");
      expect(listRuns).toBe(1);

      const approved = await dispatchApprovedCall(item.deferredCall!, item.id, { tools: [deleteFile, taskList], security });
      expect(approved.status).toBe("ok");
      expect(deleted).toEqual([target]);
      expect(parked()).toHaveLength(1);
    } finally { clearSessionProfile(session); }
  });
});

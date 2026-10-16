// The user's Approve on a parked call runs that exact call once, through the
// whole pipeline: the gates that parked it take the user's one-shot yes, and
// every other gate judges it again, as the run that made it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchApprovedCall } from "./approved-call.js";
import { executeToolCalls } from "./execute-tool.js";
import { getApprovalManager } from "../approval-manager.js";
import { inboxStore } from "../inbox/index.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { DeferredCallRecord } from "../inbox/types.js";
import type { ServerEvent, ToolDefinition } from "../types.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager } from "../rbac.js";

const SESSION = "cron-nightly-1700000000000";
let dir: string;
let shellRuns: string[];
const prevDataDir = process.env.LAX_DATA_DIR;

const bash = {
  name: "bash", description: "stub", parameters: { type: "object", properties: {} },
  execute: async (args: Record<string, unknown>) => { shellRuns.push(String(args.command)); return { content: `ran ${String(args.command)}` }; },
} as unknown as ToolDefinition;

const call = (over: Partial<DeferredCallRecord> = {}): DeferredCallRecord => ({
  toolName: "bash", args: { command: "echo hi" }, callContext: "cron", reason: "BLOCKED (unattended)", jobLabel: "Scheduled job",
  sessionId: SESSION, cronJobId: "nightly", ...over,
});

const fakeThreat = () => ({
  evaluateToolResult: vi.fn(() => ({ blocked: false })),
  isRestricted: () => false,
  getRestrictionEvidence: () => [],
}) as unknown as ThreatEngine & { evaluateToolResult: ReturnType<typeof vi.fn> };

beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-approved-call-"));
  process.env.LAX_DATA_DIR = dir;
  shellRuns = [];
  // Safe asks before any shell call, so the run parks it at the approval
  // phase, and on an unconfined host the unattended shell gate would refuse
  // it again after that.
  setSessionProfile(SESSION, "Safe");
});
afterEach(() => {
  clearSessionProfile(SESSION);
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Record<string, unknown> = {}) {
  return { tools: [bash], security: undefined as never, ...over };
}

describe("dispatchApprovedCall", () => {
  it("runs the exact call once: the approval phase takes the yes without a card, the shell gate honours it, the threat engine sees it as the user's", async () => {
    const events: ServerEvent[] = [];
    const threatEngine = fakeThreat();
    const out = await dispatchApprovedCall(call(), "inb_1", deps({ threatEngine, onEvent: (e: ServerEvent) => events.push(e) }));
    expect(out.status).toBe("ok");
    expect(out.text).toContain("ran echo hi");
    expect(shellRuns).toEqual(["echo hi"]);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(getApprovalManager().pendingCount()).toBe(0);
    expect(threatEngine.evaluateToolResult).toHaveBeenCalledTimes(1);
    expect(threatEngine.evaluateToolResult.mock.calls[0][4]).toMatchObject({ approvedByUser: true });
    expect(inboxStore().list()).toHaveLength(0);
  });

  it("leaves no grant behind, so the same call dispatched again unattended is parked, not run", async () => {
    await dispatchApprovedCall(call(), "inb_1", deps());
    expect(getApprovalManager().callGrants.size()).toBe(0);
    const msgs = await executeToolCalls(
      [{ id: "again", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
      new Map([["bash", bash]]), undefined as never, undefined, undefined, undefined, undefined, SESSION,
      undefined, undefined, undefined, undefined, undefined, "cron",
    );
    expect(shellRuns).toEqual(["echo hi"]);
    expect(String(msgs[0]?.content)).toMatch(/^\[blocked, /);
    expect(inboxStore().list().map((i) => i.kind)).toEqual(["approval"]);
  });

  it("a grant no gate needed is revoked when the dispatch returns", async () => {
    clearSessionProfile(SESSION);
    setSessionProfile(SESSION, "Autonomous");
    const local = call({ callContext: "delegated", sessionId: "delegated-wt-1", cronJobId: undefined });
    const taskList = { name: "task_list", description: "stub", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "none" }) } as unknown as ToolDefinition;
    const out = await dispatchApprovedCall({ ...local, toolName: "task_list", args: {} }, "inb_2", deps({ tools: [taskList] }));
    expect(out.status).toBe("ok");
    expect(getApprovalManager().callGrants.size()).toBe(0);
  });

  it("every other gate still judges it: a kill switch turned off since the run blocks it, and nothing runs", async () => {
    const before = getRuntimeConfig();
    setRuntimeConfig({ ...before, enableShell: false });
    try {
      const out = await dispatchApprovedCall(call(), "inb_3", deps());
      expect(out.status).toBe("blocked");
      expect(out.text).toMatch(/Shell Access is disabled/);
    } finally { setRuntimeConfig(before); }
    expect(shellRuns).toEqual([]);
    expect(getApprovalManager().callGrants.size()).toBe(0);
  });

  it("RBAC judges it as the role the run dispatched with, never the approver's", async () => {
    const checkTool = vi.fn((role: string) => role === "agent"
      ? { allowed: false, role, reason: "agents may not use bash" }
      : { allowed: true, role, reason: "ok" });
    const rbac = { checkTool } as unknown as RBACManager;
    const out = await dispatchApprovedCall(call({ callerRole: "agent" }), "inb_4", deps({ rbac }));
    expect(checkTool).toHaveBeenCalledWith("agent", "bash");
    expect(checkTool).not.toHaveBeenCalledWith("operator", expect.anything());
    expect(out.status).toBe("blocked");
    expect(shellRuns).toEqual([]);
  });
});

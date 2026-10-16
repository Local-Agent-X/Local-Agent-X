// A tool call an unattended run refused for want of a person lands in the
// user's inbox, from every gate that refuses that way, with a record complete
// enough to run that exact call later (phase 2). Before this, the refusal
// reached only the model's tool result.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireApprovalPhase } from "./require-approval.js";
import { secretEnvGate } from "./secret-env-approval.js";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { reportUnattendedRefusal } from "./unattended-refusal.js";
import { inboxStore } from "../inbox/index.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import type { CallContext, ToolCallContext } from "./context.js";
import type { ToolDefinition } from "../types.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-refusal-inbox-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function ctx(name: string, args: Record<string, unknown>, callContext: CallContext, sessionId = "cron-job1-1700000000000", over: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    tc: { id: `tc-${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) },
    args, sessionId, callContext, operationId: "op_refused_1", approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
    ...over,
  } as unknown as ToolCallContext;
}

const refused = () => inboxStore().list().filter((i) => i.kind === "refused-action");

describe("the approval phase's unattended refusal", () => {
  it("posts one needs-you item naming the job, the tool and the reason, with the full call kept server-side", async () => {
    const c = ctx("write", { path: "notes.md", content: "hello", _sessionId: "cron-job1-1700000000000" }, "cron", undefined, {
      policyApprovalReason: "this write needs the user's yes",
    });
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    const items = refused();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ needsYou: true, link: { sessionId: "cron-job1-1700000000000", opId: "op_refused_1" } });
    expect(items[0].title).toBe("Scheduled job: write needs your OK");
    expect(items[0].body).toContain("BLOCKED (unattended): write needs human approval because this write needs the user's yes");
    expect(items[0].refusedCall).toEqual({
      toolName: "write",
      args: { path: "notes.md", content: "hello" },
      callContext: "cron",
      reason: String(c.result?.content),
      jobLabel: "Scheduled job",
      sessionId: "cron-job1-1700000000000",
      opId: "op_refused_1",
    });
  });

  it("the same call refused again in the same run updates the one item; a different call is its own item", async () => {
    const make = (content: string) => ctx("write", { path: "notes.md", content }, "delegated", "op-session-1", { policyApprovalReason: "needs a person" });
    await requireApprovalPhase(make("a"));
    await requireApprovalPhase(make("a"));
    expect(refused()).toHaveLength(1);
    await requireApprovalPhase(make("b"));
    expect(refused()).toHaveLength(2);
  });

  it("an attended run's card and a headless harness run post nothing", async () => {
    reportUnattendedRefusal(ctx("write", { path: "x" }, "local", "s1"), "n/a");
    const harness = ctx("write", { path: "x" }, "delegated", "skill-review-1-1", { policyApprovalReason: "needs a person" });
    expect((await requireApprovalPhase(harness)).kind).toBe("halt");
    expect(refused()).toHaveLength(0);
  });
});

describe("the secret_env gate's unattended refusal", () => {
  it("posts the refused call, secret NAMES only", async () => {
    const session = "delegated-secret-1";
    setSessionProfile(session, "Normal");
    try {
      const c = ctx("bash", { command: "gh release list", secret_env: { GH_TOKEN: "GITHUB_TOKEN" } }, "delegated", session);
      expect((await secretEnvGate(c)).kind).toBe("blocked");
    } finally { clearSessionProfile(session); }
    const items = refused();
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain("needs the user's yes under this profile");
    expect(items[0].refusedCall?.args).toEqual({ command: "gh release list", secret_env: { GH_TOKEN: "GITHUB_TOKEN" } });
  });
});

describe("the unattended shell gate's refusal", () => {
  it("a cron run's shell call is refused and posted", async () => {
    const tool = { name: "bash", execute: async () => ({ content: "ran" }) } as unknown as ToolDefinition;
    const c = ctx("bash", { command: "npm test" }, "cron", undefined, { tool });
    await runSandboxedPhase(c);
    expect(String(c.result?.content)).toContain("categorically disabled for cron runs");
    expect(refused().map((i) => i.refusedCall?.toolName)).toEqual(["bash"]);
  });
});

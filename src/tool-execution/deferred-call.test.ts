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
import { blocked, needsUser } from "../tools/result-helpers.js";
import { callContextOf, userGrantOf } from "./internal-args.js";
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
  // An unconfined host nobody acknowledged (a fresh data dir has no
  // acknowledgement), and a run with no work root to scope it.
  const prevSandbox = process.env.LAX_SANDBOX;
  beforeEach(() => { process.env.LAX_SANDBOX = "host"; });
  afterEach(() => { if (prevSandbox === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevSandbox; });

  it("a cron run's unscoped shell call on an unacknowledged host is parked, its own reason kept", async () => {
    const tool = { name: "bash", execute: async () => ({ content: "ran" }) } as unknown as ToolDefinition;
    const c = ctx("bash", { command: "npm test" }, "cron", undefined, { tool });
    await runSandboxedPhase(c);
    expect(String(c.result?.content)).toContain("must explicitly acknowledge unconfined unattended shell execution");
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

// A gate inside a tool (the browser's sensitive-page, download and CAPTCHA
// gates, the credential fill's first-use ask) cannot reach the inbox itself:
// it marks its refusal needsUser (tools/result-helpers.ts) and the pipeline
// parks that call the way it parks its own gates' refusals.
describe("a gate inside the tool that found no one to ask", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  const stub = (name: string, execute: ToolDefinition["execute"], readOnly = false) =>
    ({ name, description: "stub", parameters: { type: "object", properties: {} }, readOnly, execute }) as unknown as ToolDefinition;
  const taskList = stub("task_list", async () => ({ content: "no tasks" }), true);
  const REASON = "This high-risk browser action targets a financial account page. (click on https://www.chase.com/pay)";
  const refusal = () => blocked("BLOCKED: This high-risk browser action targets a financial account page. Explicit approval is unavailable in this run.", {
    layer: "browser-sensitive-page", browserStatus: "approval-required", recovery: "This run cannot ask the user.",
  });

  it("has its needs-you refusal parked, the run goes on, and the user's Approve runs it with the grant", async () => {
    const session = "cron-shop-1700000000000";
    const seen: Array<{ context: string | undefined; grant: string | undefined }> = [];
    const browser = stub("browser", async (a) => {
      seen.push({ context: callContextOf(a), grant: userGrantOf(a) });
      return userGrantOf(a) ? { content: "Clicked: Pay" } : needsUser(refusal(), REASON);
    });
    const tools = new Map([["browser", browser], ["task_list", taskList]]);
    const security = new SecurityLayer(join(dir, "workspace"), "workspace");
    const msgs = await executeToolCalls(
      [
        { id: "c1", name: "browser", arguments: JSON.stringify({ action: "click", selector: "#pay" }) },
        { id: "c2", name: "task_list", arguments: "{}" },
      ],
      tools, security, undefined, undefined, undefined, undefined, session,
      undefined, undefined, undefined, undefined, "op_shop_1", "cron",
    );
    expect(seen).toEqual([{ context: "cron", grant: undefined }]);
    const item = parked()[0];
    expect(item?.deferredCall).toMatchObject({ toolName: "browser", args: { action: "click", selector: "#pay" }, cronJobId: "shop", callContext: "cron" });
    expect(item.body).toContain(`Why it needs you: ${REASON}`);
    const [first, second] = msgs.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(first).toMatch(/^\[blocked, /);
    expect(first).toContain(`deferredTo="${item.id}"`);
    expect(first).toContain('layer="approval"');
    expect(first).not.toContain("needsUser");
    expect(second).toContain("no tasks");

    const approved = await dispatchApprovedCall(item.deferredCall!, item.id, { tools: [browser, taskList], security });
    expect(approved.status).toBe("ok");
    expect(approved.text).toContain("Clicked: Pay");
    expect(seen[1]).toMatchObject({ context: "cron" });
    expect(seen[1]?.grant).toMatch(/^grant-/);
    expect(parked()).toHaveLength(1);
  });

  it("an attended run keeps the tool's own refusal: unparked, and the mark never reaches the model", async () => {
    const browser = stub("browser", async () => needsUser(refusal(), REASON));
    const security = new SecurityLayer(join(dir, "workspace"), "workspace");
    const msgs = await executeToolCalls(
      [{ id: "c1", name: "browser", arguments: JSON.stringify({ action: "click", selector: "#pay" }) }],
      new Map([["browser", browser]]), security, undefined, undefined, undefined, undefined, "chat-1",
      undefined, undefined, undefined, undefined, undefined, "local",
    );
    const rendered = String(msgs.find((m) => m.role === "tool")?.content);
    expect(rendered).toMatch(/^\[blocked, /);
    expect(rendered).toContain('layer="browser-sensitive-page"');
    expect(rendered).not.toContain("deferredTo");
    expect(rendered).not.toContain("needsUser");
    expect(parked()).toHaveLength(0);
  });
});

// With the blanket denial gone, a scheduled run browses its own work and reads
// the public pages the web-access policy allows with no card, and makes images.
describe("a scheduled run's browser and image calls", () => {
  beforeAll(() => setAriRequired(false));
  afterAll(() => setAriRequired(true));

  const session = "cron-site-1700000000000";
  const run = async (opId: string, security: SecurityLayer, tools: Map<string, ToolDefinition>, calls: Array<{ name: string; args: Record<string, unknown> }>) => {
    const msgs = await executeToolCalls(
      calls.map((c, i) => ({ id: `${opId}-c${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      tools, security, undefined, undefined, undefined, undefined, session,
      undefined, undefined, undefined, undefined, opId, "cron",
    );
    return msgs.filter((m) => m.role === "tool").map((m) => String(m.content));
  };

  it("drives this install's app pages, a localhost dev server and an allowed public host; an unlisted host is refused by policy, not parked", async () => {
    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const security = new SecurityLayer(workspace, "workspace");
    security.egress.setMode("strict");
    security.egress.allow("example.com");
    const visited: string[] = [];
    const browser = { name: "browser", description: "stub", parameters: { type: "object", properties: {} }, execute: async (a: Record<string, unknown>) => { visited.push(String(a.url)); return { content: `Navigated to: ${String(a.url)}` }; } } as unknown as ToolDefinition;
    const out = await run("op_site_browse", security, new Map([["browser", browser]]), [
      { name: "browser", args: { action: "navigate", url: "http://127.0.0.1:7007/apps/calendar/" } },
      { name: "browser", args: { action: "navigate", url: "http://localhost:5173/" } },
      { name: "browser", args: { action: "navigate", url: "https://example.com/docs" } },
      { name: "browser", args: { action: "screenshot" } },
      { name: "browser", args: { action: "navigate", url: "https://evil.example.net/" } },
    ]);
    expect(visited).toEqual(["http://127.0.0.1:7007/apps/calendar/", "http://localhost:5173/", "https://example.com/docs", "undefined"]);
    expect(out.slice(0, 4).every((r) => !/^\[blocked, /.test(r))).toBe(true);
    expect(out[4]).toMatch(/^\[blocked, /);
    expect(out[4]).not.toContain("deferredTo");
    expect(parked()).toHaveLength(0);
  });

  it("makes an image: the run reaches the tool, which decides the engine and what it may bill", async () => {
    const security = new SecurityLayer(join(dir, "workspace"), "workspace");
    const prompts: string[] = [];
    const generate = { name: "generate_image", description: "stub", parameters: { type: "object", properties: {} }, execute: async (a: Record<string, unknown>) => { prompts.push(String(a.prompt)); return { content: "made" }; } } as unknown as ToolDefinition;
    const [out] = await run("op_site_image", security, new Map([["generate_image", generate]]), [{ name: "generate_image", args: { prompt: "a calendar icon" } }]);
    expect(prompts).toEqual(["a calendar icon"]);
    expect(out).toContain("made");
  });
});

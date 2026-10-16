// POST /api/inbox/act: the user's answer to a call an unattended run parked.
// Approve runs that exact call once, through the real pipeline, and reports
// its outcome as a new item; Decline runs nothing. Only the user answers, a
// double click runs nothing twice, and every answer reaches every open tab.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import type { ToolDefinition } from "../types.js";
import { inboxStore } from "../inbox/index.js";
import { inboxApprovalRequest } from "../inbox/approvals.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { handleInboxRoutes } from "./inbox.js";

let dir: string;
let shellRuns: string[];
const prev = process.env.LAX_DATA_DIR;
beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-inbox-act-"));
  mkdirSync(join(dir, "workspace"));
  process.env.LAX_DATA_DIR = dir;
  shellRuns = [];
});
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

const bash = {
  name: "bash", description: "stub", parameters: { type: "object", properties: {} },
  execute: async (args: Record<string, unknown>) => { shellRuns.push(String(args.command)); return { content: `ran ${String(args.command)}` }; },
} as unknown as ToolDefinition;

function mkRes() {
  let status = 0;
  let body = "";
  const res = { writeHead: (s: number) => { status = s; }, setHeader: () => {}, end: (b: string) => { body = b; } } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as Record<string, unknown> };
}

function mkReq(json: unknown): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(json))];
  return { headers: { "content-type": "application/json" }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } } as unknown as IncomingMessage;
}

function mkCtx(tools: ToolDefinition[] = [bash]) {
  const broadcastAll = vi.fn();
  const ctx = {
    broadcastAll, allAgentTools: tools, config: { workspace: join(dir, "workspace") }, dataDir: dir,
    getActiveOnEvent: () => undefined,
  } as unknown as ServerContext;
  return { ctx, broadcastAll };
}

async function act(body: unknown, role: Role = "user", tools?: ToolDefinition[]) {
  const { ctx, broadcastAll } = mkCtx(tools);
  const r = mkRes();
  await handleInboxRoutes("POST", new URL("http://localhost/api/inbox/act"), mkReq(body), r.res, ctx, role);
  return { status: r.status(), body: r.body(), broadcastAll };
}

// An api run's shell call, parked by the unattended shell gate.
function park(toolName = "bash") {
  return inboxApprovalRequest({
    toolName, args: { command: "echo hi" }, callContext: "api", reason: "BLOCKED (unattended): bash cannot execute in this api context.",
    jobLabel: "Background task \"nightly sync\"", sessionId: "api-nightly-1",
  })!;
}

describe("who may answer", () => {
  it("refuses the agent principal and a readonly role; nothing runs and nothing is broadcast", async () => {
    const item = park();
    for (const role of ["agent", "readonly"] as const) {
      const r = await act({ id: item.id, action: "approve" }, role);
      expect(r.status, role).toBe(403);
      expect(r.broadcastAll).not.toHaveBeenCalled();
    }
    expect(shellRuns).toEqual([]);
    expect(inboxStore().get(item.id)?.resolvedAt).toBeUndefined();
  });
});

describe("Decline", () => {
  it("runs nothing, closes the item as declined, and tells every tab", async () => {
    const item = park();
    const r = await act({ id: item.id, action: "decline" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, resolution: "declined", needsYou: 0 });
    expect(r.broadcastAll).toHaveBeenCalledWith(expect.objectContaining({ type: "inbox_changed", action: "decline", id: item.id }));
    expect(inboxStore().get(item.id)).toMatchObject({ resolution: "declined" });
    expect(inboxStore().get(item.id)?.resolvedAt).toBeDefined();
    expect(shellRuns).toEqual([]);
    expect((await act({ id: item.id, action: "approve" })).status).toBe(409);
    expect(shellRuns).toEqual([]);
  });
});

describe("Approve", () => {
  it("runs the stored call once through the pipeline, reports the outcome as a new item, and a second Approve runs nothing", async () => {
    const item = park();
    const r = await act({ id: item.id, action: "approve" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, resolution: "approved", outcome: "ok" });
    expect(shellRuns).toEqual(["echo hi"]);
    expect(r.broadcastAll).toHaveBeenCalledWith(expect.objectContaining({ type: "inbox_changed", action: "approve", id: item.id }));
    const result = inboxStore().get(String(r.body.resultId));
    expect(result).toMatchObject({ kind: "job", title: "Your approved bash call ran", needsYou: false, link: { sessionId: "api-nightly-1" } });
    expect(result?.body).toContain("ran echo hi");
    expect(inboxStore().get(item.id)).toMatchObject({ resolution: "approved" });

    const again = await act({ id: item.id, action: "approve" });
    expect(again.status).toBe(409);
    expect(again.broadcastAll).not.toHaveBeenCalled();
    expect(shellRuns).toEqual(["echo hi"]);
  });

  it("two Approves at once run it once: the store's claim, not the client, decides", async () => {
    const item = park();
    const both = await Promise.all([act({ id: item.id, action: "approve" }), act({ id: item.id, action: "approve" })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(shellRuns).toEqual(["echo hi"]);
  });

  it("the user's yes answers only the asking gates: a scheduled run's shell call, which the security layer forbids in cron, stays blocked and says so", async () => {
    const item = inboxApprovalRequest({
      toolName: "bash", args: { command: "echo hi" }, callContext: "cron", reason: "BLOCKED (unattended): bash cannot execute in this cron context.",
      jobLabel: "Scheduled job", cronJobId: "nightly", sessionId: "cron-nightly-1700000000000",
    })!;
    const r = await act({ id: item.id, action: "approve" });
    expect(r.body).toMatchObject({ ok: true, resolution: "approved", outcome: "blocked" });
    expect(shellRuns).toEqual([]);
    const result = inboxStore().get(String(r.body.resultId));
    expect(result).toMatchObject({ kind: "job", title: "Your approved bash call was blocked", needsYou: true });
    expect(result?.body).toContain("not allowed in cron context");
  });

  it("a call whose tool no longer exists is resolved as failed, says so, and runs nothing", async () => {
    const item = park("renamed_away_tool");
    const r = await act({ id: item.id, action: "approve" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, resolution: "failed" });
    expect(String(r.body.error)).toContain('no tool named "renamed_away_tool"');
    expect(inboxStore().get(item.id)).toMatchObject({ resolution: "failed" });
    expect(inboxStore().get(String(r.body.resultId))).toMatchObject({ kind: "job", needsYou: true, title: "Your approved renamed_away_tool call could not run" });
  });
});

describe("bad requests", () => {
  it("an unknown action is 400, an item that is not an approval is 400, an unknown id is 404", async () => {
    const item = park();
    const job = inboxStore().post({ kind: "job", title: "Report finished", body: "", needsYou: false }).item;
    expect((await act({ id: item.id, action: "maybe" })).status).toBe(400);
    expect((await act({ id: job.id, action: "approve" })).status).toBe(400);
    expect((await act({ id: "inb_nope", action: "decline" })).status).toBe(404);
    expect((await act({ action: "approve" })).status).toBe(400);
    expect(shellRuns).toEqual([]);
  });
});

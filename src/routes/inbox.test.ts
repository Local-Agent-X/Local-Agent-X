// /api/inbox: the bell's list and the user's answers. Every mutation must
// broadcast so every open tab redraws, and the agent principal must never
// read or answer the user's inbox.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import { inboxStore } from "../inbox/index.js";
import { handleInboxRoutes } from "./inbox.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-inbox-route-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

function mkRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; },
    setHeader: () => {},
    end: (b: string) => { body = b; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as Record<string, unknown> };
}

function mkReq(json?: unknown): IncomingMessage {
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))];
  return {
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  } as unknown as IncomingMessage;
}

function mkCtx() {
  const broadcastAll = vi.fn();
  return { ctx: { broadcastAll } as unknown as ServerContext, broadcastAll };
}

const url = (p: string) => new URL(`http://localhost${p}`);

async function call(method: string, path: string, body?: unknown, role: Role = "operator") {
  const { ctx, broadcastAll } = mkCtx();
  const r = mkRes();
  const handled = await handleInboxRoutes(method, url(path), mkReq(body), r.res, ctx, role);
  return { handled, status: r.status(), body: handled && r.status() ? r.body() : null, broadcastAll };
}

function seed() {
  const store = inboxStore();
  const urgent = store.post({
    kind: "refused-action", title: "Scheduled job: bash needs your OK", body: "BLOCKED", needsYou: true, key: "refused:op1:abc",
    refusedCall: { toolName: "bash", args: { command: "npm publish" }, callContext: "cron", reason: "BLOCKED", jobLabel: "Scheduled job" },
  }).item;
  const plain = store.post({ kind: "job", title: "Background task finished", body: "ok", needsYou: false }).item;
  return { urgent, plain };
}

describe("GET /api/inbox", () => {
  it("lists the items with unread and needs-you counts, needs-you first", async () => {
    const { urgent, plain } = seed();
    const r = await call("GET", "/api/inbox");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unread: 2, needsYou: 1 });
    expect((r.body!.items as Array<{ id: string }>).map((i) => i.id)).toEqual([urgent.id, plain.id]);
  });

  it("never ships the server-side refused-call record or the producer key", async () => {
    seed();
    const r = await call("GET", "/api/inbox");
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("npm publish");
    expect(text).not.toContain("refused:op1");
  });
});

describe("mutating POSTs", () => {
  const cases: Array<{ path: string; action: string; withId: boolean }> = [
    { path: "/api/inbox/read", action: "read", withId: true },
    { path: "/api/inbox/read-all", action: "read_all", withId: false },
    { path: "/api/inbox/dismiss", action: "dismiss", withId: true },
    { path: "/api/inbox/resolve", action: "resolve", withId: true },
  ];
  for (const c of cases) {
    it(`${c.path} applies, answers the counts and broadcasts inbox_changed`, async () => {
      const { urgent } = seed();
      const r = await call("POST", c.path, c.withId ? { id: urgent.id } : undefined);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true });
      expect(r.broadcastAll).toHaveBeenCalledTimes(1);
      expect(r.broadcastAll).toHaveBeenCalledWith({
        type: "inbox_changed", action: c.action, ...(c.withId ? { id: urgent.id } : {}),
        unread: r.body!.unread, needsYou: r.body!.needsYou,
      });
    });
  }

  it("each mutation lands in the store", async () => {
    const { urgent, plain } = seed();
    await call("POST", "/api/inbox/read", { id: plain.id });
    expect(inboxStore().get(plain.id)?.readAt).toBeDefined();
    await call("POST", "/api/inbox/resolve", { id: urgent.id });
    expect(inboxStore().counts()).toEqual({ unread: 0, needsYou: 0 });
    await call("POST", "/api/inbox/dismiss", { id: urgent.id });
    expect(inboxStore().list().map((i) => i.id)).toEqual([plain.id]);
  });

  it("a missing id is 400 and an unknown id is 404, and neither broadcasts", async () => {
    seed();
    const missing = await call("POST", "/api/inbox/dismiss", {});
    expect(missing.status).toBe(400);
    const unknown = await call("POST", "/api/inbox/resolve", { id: "inb_nope" });
    expect(unknown.status).toBe(404);
    expect(missing.broadcastAll).not.toHaveBeenCalled();
    expect(unknown.broadcastAll).not.toHaveBeenCalled();
  });
});

describe("who may use it", () => {
  it("refuses the agent principal on every path, read and write", async () => {
    const { urgent } = seed();
    for (const [method, path] of [["GET", "/api/inbox"], ["POST", "/api/inbox/dismiss"], ["POST", "/api/inbox/resolve"]] as const) {
      const r = await call(method, path, { id: urgent.id }, "agent");
      expect(r.status, path).toBe(403);
      expect(r.broadcastAll).not.toHaveBeenCalled();
    }
    expect(inboxStore().list()).toHaveLength(2);
  });

  it("lets a readonly role read but not answer", async () => {
    const { urgent } = seed();
    expect((await call("GET", "/api/inbox", undefined, "readonly")).status).toBe(200);
    expect((await call("POST", "/api/inbox/resolve", { id: urgent.id }, "readonly")).status).toBe(403);
  });

  it("does not claim other paths", async () => {
    expect((await call("GET", "/api/inboxes")).handled).toBe(false);
    expect((await call("POST", "/api/inbox/unknown")).handled).toBe(false);
  });
});

/**
 * Deny-reason route — handler ownership, the non-consuming peek contract
 * (the UI can read the reason repeatedly while the agent-side navigate error
 * path still gets its one recentEgressDeny consume), view scoping, and the
 * auth fence (the path sits inside the /api/* gate, not in AUTH_EXEMPT).
 */
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../../server-context.js";
import type { Role } from "../../rbac.js";
import type { LAXConfig } from "../../types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { RBACManager } from "../../rbac.js";
import { authorizeRequest } from "../../server/request-auth.js";
import { recordEgressDeny, recentEgressDeny, peekEgressDeny } from "../../browser/bridge-egress.js";
import { handleBrowserDenyReasonRoutes } from "./deny-reason.js";

function mkRes() {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b: string) => { body = b; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as unknown };
}

function mkReq(): IncomingMessage {
  const stream = Readable.from([]);
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  (stream as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  return stream as unknown as IncomingMessage;
}

const ctx = {} as ServerContext;
const role = "owner" as Role;
const u = (path: string) => new URL(`http://localhost${path}`);
const q = (target: string, viewId?: string) =>
  u(`/api/browser/deny-reason?url=${encodeURIComponent(target)}` +
    (viewId ? `&viewId=${encodeURIComponent(viewId)}` : ""));

describe("handleBrowserDenyReasonRoutes", () => {
  it("returns the recorded deny WITHOUT consuming it — two reads, then the navigate path still consumes", async () => {
    recordEgressDeny("https://blocked.example/page", "view-a-work", "policy deny", "add the host to the allowlist");

    let r = mkRes();
    expect(await handleBrowserDenyReasonRoutes("GET", q("https://blocked.example/page", "view-a-work"), mkReq(), r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.body()).toEqual({ reason: "policy deny", recovery: "add the host to the allowlist" });

    // Second sequential fetch: the peek did not consume.
    r = mkRes();
    await handleBrowserDenyReasonRoutes("GET", q("https://blocked.example/page", "view-a-work"), mkReq(), r.res, ctx, role);
    expect(r.body()).toEqual({ reason: "policy deny", recovery: "add the host to the allowlist" });

    // The agent-side navigate error path still gets its one consume.
    expect(recentEgressDeny("https://blocked.example/page", "view-a-work")?.reason).toBe("policy deny");
    expect(peekEgressDeny("https://blocked.example/page", "view-a-work")).toBeNull();
  });

  it("returns {} for a URL with no recorded deny", async () => {
    const r = mkRes();
    expect(await handleBrowserDenyReasonRoutes("GET", q("https://never-denied.example/"), mkReq(), r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.body()).toEqual({});
  });

  it("scopes the lookup to the exact view (no cross-view leak, no null-scope hit)", async () => {
    recordEgressDeny("https://scoped.example/", "view-a-work", "reason A");
    let r = mkRes();
    await handleBrowserDenyReasonRoutes("GET", q("https://scoped.example/", "view-b-work"), mkReq(), r.res, ctx, role);
    expect(r.body()).toEqual({});
    r = mkRes();
    await handleBrowserDenyReasonRoutes("GET", q("https://scoped.example/"), mkReq(), r.res, ctx, role);
    expect(r.body()).toEqual({});
    r = mkRes();
    await handleBrowserDenyReasonRoutes("GET", q("https://scoped.example/", "view-a-work"), mkReq(), r.res, ctx, role);
    expect(r.body()).toEqual({ reason: "reason A" });
  });

  it("400s when the url param is missing", async () => {
    const r = mkRes();
    expect(await handleBrowserDenyReasonRoutes("GET", u("/api/browser/deny-reason"), mkReq(), r.res, ctx, role)).toBe(true);
    expect(r.status()).toBe(400);
  });

  it("does not claim other paths or methods", async () => {
    const r = mkRes();
    expect(await handleBrowserDenyReasonRoutes("POST", q("https://x.example/"), mkReq(), r.res, ctx, role)).toBe(false);
    expect(await handleBrowserDenyReasonRoutes("GET", u("/api/browser/bookmarks"), mkReq(), r.res, ctx, role)).toBe(false);
  });

  it("sits inside the auth fence: a token-less request is 401'd before the handler runs", () => {
    const token = "OP_TOKEN_" + "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const rbac = new RBACManager(getLaxDir(), token);
    const config = { authToken: token } as LAXConfig;
    const r = mkRes();
    const auth = authorizeRequest("GET", q("https://blocked.example/page"), mkReq(), r.res, config, rbac);
    expect(auth.handled).toBe(true);
    expect(r.status()).toBe(401);
  });
});

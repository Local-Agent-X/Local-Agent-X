// GET/POST /api/security/egress: the Web access policy the Settings section
// and the chat's "Allow & retry" notice drive. The route mutates the layer's
// EgressPolicyState (which persists), broadcasts the new snapshot so every tab
// redraws, and refuses roles that may not loosen the egress floor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import { EgressPolicyState } from "../security/layer/egress-policy-state.js";
import { handleSecurityRoutes } from "./security.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-egress-route-")); process.env.LAX_DATA_DIR = dir; });
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

// readBody iterates the request (`for await`), so the fake is an async iterable of one chunk.
function mkReq(json?: unknown): IncomingMessage {
  const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))];
  return {
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  } as unknown as IncomingMessage;
}

function mkCtx() {
  const broadcastAll = vi.fn();
  const ctx = { security: { egress: new EgressPolicyState() }, broadcastAll } as unknown as ServerContext;
  return { ctx, broadcastAll };
}

const url = (p: string) => new URL(`http://localhost${p}`);

describe("/api/security/egress", () => {
  it("GET returns the snapshot", async () => {
    const { ctx } = mkCtx();
    const { res, status, body } = mkRes();
    expect(await handleSecurityRoutes("GET", url("/api/security/egress"), mkReq(), res, ctx, "user" as Role)).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toEqual({ mode: "permissive", allowlist: [], configured: false });
  });

  it("POST allow/mode persists, answers the snapshot, and broadcasts settings_changed", async () => {
    const { ctx, broadcastAll } = mkCtx();
    const { res, status, body } = mkRes();
    await handleSecurityRoutes("POST", url("/api/security/egress"), mkReq({ mode: "strict", allow: "https://API.example.com/x" }), res, ctx, "user" as Role);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, mode: "strict", allowlist: ["api.example.com"], configured: true });
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { egress: { mode: "strict", allowlist: ["api.example.com"], configured: true } } });
    expect(JSON.parse(readFileSync(join(dir, "egress-allowlist.json"), "utf-8"))).toEqual(["api.example.com"]);
    expect(JSON.parse(readFileSync(join(dir, "security.json"), "utf-8"))).toEqual({ egressMode: "strict" });
  });

  it("POST rejects a bad mode and a non-host, and leaves the policy alone", async () => {
    const { ctx, broadcastAll } = mkCtx();
    for (const bad of [{ mode: "open" }, { allow: "not a host" }]) {
      const { res, status } = mkRes();
      await handleSecurityRoutes("POST", url("/api/security/egress"), mkReq(bad), res, ctx, "operator" as Role);
      expect(status()).toBe(400);
    }
    expect(broadcastAll).not.toHaveBeenCalled();
    expect((ctx as unknown as { security: { egress: EgressPolicyState } }).security.egress.snapshot()).toEqual({ mode: "permissive", allowlist: [], configured: false });
  });

  it("POST is refused for the agent and readonly roles", async () => {
    const { ctx, broadcastAll } = mkCtx();
    for (const role of ["agent", "readonly"]) {
      const { res, status } = mkRes();
      await handleSecurityRoutes("POST", url("/api/security/egress"), mkReq({ mode: "permissive" }), res, ctx, role as Role);
      expect(status()).toBe(403);
    }
    expect(broadcastAll).not.toHaveBeenCalled();
  });
});

// The operator credential never expires (rbac.ts), so rotation is the one
// control against a leaked token. GET says when it was last rotated and how a
// rotation restarts; POST mints a new token, persists it to config.json,
// re-keys RBAC so the old token stops working at once, and is operator-only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../server-context.js";
import type { Role } from "../rbac.js";
import { RBACManager } from "../rbac.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { handleSecurityRoutes } from "./security.js";

vi.mock("../desktop-bridge.js", () => ({ desktopBridgeAvailable: () => false, desktopRestartServer: () => false }));

let dir: string;
const prev = process.env.LAX_DATA_DIR;
const prevAudit = process.env.LAX_AUDIT_KEY;
let rbac: RBACManager;
let bootToken: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-operator-token-"));
  process.env.LAX_DATA_DIR = dir;
  process.env.LAX_AUDIT_KEY = "test-operator-token-key-0123456789";
  bootToken = randomBytes(32).toString("hex");
  rbac = new RBACManager(dir, bootToken);
  setRuntimeConfig({ ...getRuntimeConfig(), authToken: bootToken } as LAXConfig);
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  if (prevAudit === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevAudit;
  rmSync(dir, { recursive: true, force: true });
});

function mkRes() {
  let status = 0;
  let body = "";
  const res = { writeHead: (s: number) => { status = s; }, setHeader: () => {}, end: (b: string) => { body = b; } } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(body) as Record<string, unknown> };
}
const req = { headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from("{}"); } } as unknown as IncomingMessage;
const url = (p: string) => new URL(`http://localhost${p}`);
const ctx = () => ({ rbac, broadcastAll: vi.fn() }) as unknown as ServerContext;

describe("/api/security/operator-token", () => {
  it("GET reports when the credential was minted and that a restart is manual without the desktop", async () => {
    const { res, status, body } = mkRes();
    expect(await handleSecurityRoutes("GET", url("/api/security/operator-token"), req, res, ctx(), "operator" as Role)).toBe(true);
    expect(status()).toBe(200);
    expect(typeof body().rotatedAt).toBe("number");
    expect(body().restart).toBe("manual");
  });

  it("POST rotate mints a new token, persists it, and the old one stops authenticating", async () => {
    const { res, status, body } = mkRes();
    await handleSecurityRoutes("POST", url("/api/security/operator-token/rotate"), req, res, ctx(), "operator" as Role);
    expect(status()).toBe(200);
    const token = body().token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(bootToken);
    expect(getRuntimeConfig().authToken).toBe(token);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).authToken).toBe(token);
    expect(rbac.authenticate(token).valid).toBe(true);
    expect(rbac.authenticate(bootToken).valid).toBe(false);
    expect(rbac.listTokens().find((t) => t.id === "operator-default")?.expiresAt).toBeUndefined();
  });

  it("POST rotate is refused for every role but operator", async () => {
    for (const role of ["user", "agent", "readonly"]) {
      const { res, status } = mkRes();
      await handleSecurityRoutes("POST", url("/api/security/operator-token/rotate"), req, res, ctx(), role as Role);
      expect(status(), role).toBe(403);
    }
    expect(rbac.authenticate(bootToken).valid).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// The real status unless a test pins one (a Windows cage still proving its
// fence cannot be produced on every runner).
const pinned = vi.hoisted(() => ({ status: null as Record<string, unknown> | null }));
vi.mock("../../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sandbox/index.js")>();
  return { ...actual, getSandboxStatus: () => (pinned.status ? { ...actual.getSandboxStatus(), ...pinned.status } : actual.getSandboxStatus()) };
});

import { getRuntimeConfig, loadConfig, setRuntimeConfig } from "../../config.js";
import { getSandboxStatus } from "../../sandbox/index.js";
import { handleSystemRoutes } from "./system.js";

function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

describe("sandbox status acknowledgement API", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousMode: string | undefined;
  let previousRuntime: ReturnType<typeof getRuntimeConfig>;

  beforeAll(() => {
    previousDataDir = process.env.LAX_DATA_DIR;
    previousMode = process.env.LAX_SANDBOX;
    previousRuntime = getRuntimeConfig();
    dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-route-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    setRuntimeConfig(loadConfig());
  });

  afterAll(() => {
    setRuntimeConfig(previousRuntime);
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = previousDataDir;
    if (previousMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = previousMode;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function request(method: "GET" | "POST", body?: unknown) {
    const req = makeReq(body);
    const res = makeRes();
    const broadcastAll = vi.fn();
    const ctx = { config: getRuntimeConfig(), dataDir, broadcastAll } as unknown as Parameters<typeof handleSystemRoutes>[4];
    const handled = await handleSystemRoutes(
      method,
      new URL("http://127.0.0.1/api/sandbox"),
      req as unknown as Parameters<typeof handleSystemRoutes>[2],
      res as unknown as Parameters<typeof handleSystemRoutes>[3],
      ctx,
      "operator",
    );
    return { handled, status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, broadcastAll };
  }

  it("reports context-specific shell status", async () => {
    const response = await request("GET");
    expect(response.handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      effectiveMode: "host",
      cronShellAllowed: false,
      delegatedShellAllowed: false,
      apiShellAllowed: false,
    });
  });

  it("acknowledges and revokes delegated/API host shell with broadcasts", async () => {
    const acknowledged = await request("POST", { acknowledgeUnconfinedHost: true });
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body).toMatchObject({
      unconfinedHostAcknowledged: true,
      cronShellAllowed: false,
      delegatedShellAllowed: true,
      apiShellAllowed: true,
    });
    expect(acknowledged.broadcastAll).toHaveBeenCalledOnce();

    const revoked = await request("POST", { revokeUnconfinedHostAcknowledgement: true });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      unconfinedHostAcknowledged: false,
      cronShellAllowed: false,
      delegatedShellAllowed: false,
      apiShellAllowed: false,
    });
    expect(revoked.broadcastAll).toHaveBeenCalledOnce();
  });

  // Nothing runs unconfined while the Windows cage is being verified, and an
  // acknowledgement made then would outlive the proof.
  it("refuses an acknowledgement while the Windows cage is still being verified", async () => {
    pinned.status = { selectedMode: "guarded", effectiveMode: "host", confined: false, proofPending: true };
    try {
      const refused = await request("POST", { acknowledgeUnconfinedHost: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/^The Windows shell cage is still being verified; try again in a few seconds\./);
      expect(refused.broadcastAll).not.toHaveBeenCalled();
    } finally {
      pinned.status = null;
    }
    expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(false);
  });
});

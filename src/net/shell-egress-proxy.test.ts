import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve4 = vi.fn<(host: string) => Promise<string[]>>();
const resolve6 = vi.fn<(host: string) => Promise<string[]>>();

vi.mock("node:dns", () => ({
  promises: {
    resolve4: (host: string) => resolve4(host),
    resolve6: (host: string) => resolve6(host),
  },
}));

const auditRecord = vi.fn();
vi.mock("../threat/audit-trail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threat/audit-trail.js")>()),
  getSharedAuditTrail: () => ({ record: auditRecord }),
}));

const registerTeardown = vi.fn();
vi.mock("../local-only-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../local-only-policy.js")>()),
  registerLocalOnlyTeardown: (name: string, teardown: () => void | Promise<void>) =>
    registerTeardown(name, teardown),
}));

// Pass-through by default; lets one test force a start failure.
const failNextStart = { value: false };
vi.mock("./egress-proxy-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./egress-proxy-core.js")>();
  return {
    ...actual,
    startEgressProxy: (options: Parameters<typeof actual.startEgressProxy>[0]) =>
      failNextStart.value
        ? Promise.reject(new Error("start failed (test)"))
        : actual.startEgressProxy(options),
  };
});

import {
  closeShellEgressProxy,
  currentShellEgressProxyUrl,
  ensureShellEgressProxy,
  type ShellEgressProxy,
} from "./shell-egress-proxy.js";

const originalPort = process.env.LAX_PORT;

function requestThroughProxy(proxy: ShellEgressProxy, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(new URL(proxy.url).port),
      method: "GET",
      path: target,
      headers: { host: new URL(target).host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

beforeEach(() => {
  process.env.LAX_PORT = "7007";
  resolve4.mockReset();
  resolve6.mockReset();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
  auditRecord.mockReset();
  failNextStart.value = false;
});

afterEach(async () => {
  await closeShellEgressProxy();
  if (originalPort === undefined) delete process.env.LAX_PORT;
  else process.env.LAX_PORT = originalPort;
});

describe("shell egress proxy", () => {
  it("shares one proxy across ensures and restarts after close", async () => {
    const first = ensureShellEgressProxy();
    expect(ensureShellEgressProxy()).toBe(first);
    const proxy = await first;
    expect(await ensureShellEgressProxy()).toBe(proxy);

    await closeShellEgressProxy();

    const restarted = await ensureShellEgressProxy();
    expect(restarted).not.toBe(proxy);
    expect(restarted.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("audits exactly one shell_egress_denied block record for a policy-denied dial", async () => {
    resolve4.mockResolvedValue(["10.0.0.7"]);
    const proxy = await ensureShellEgressProxy();

    const response = await requestThroughProxy(proxy, "http://rebind.example/secret");

    expect(response.status).toBe(403);
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledWith({
      sessionId: "shell-egress-proxy",
      event: "shell_egress_denied",
      toolName: "bash",
      decision: "block",
      reason: `${response.body} (target: http://rebind.example/secret)`,
    });
  });

  it("registers the local-only teardown once, not per ensure", async () => {
    await ensureShellEgressProxy();
    await ensureShellEgressProxy();
    await closeShellEgressProxy();
    await ensureShellEgressProxy();

    expect(registerTeardown).toHaveBeenCalledTimes(1);
    expect(registerTeardown).toHaveBeenCalledWith("shell-egress-proxy", closeShellEgressProxy);
  });
});

describe("currentShellEgressProxyUrl (live mirror)", () => {
  it("is null before start, the live URL after ensure, and null again after close", async () => {
    expect(currentShellEgressProxyUrl()).toBeNull();

    const proxy = await ensureShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBe(proxy.url);

    await closeShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBeNull();
  });

  it("stays null through a failed start, then mirrors the next successful one", async () => {
    failNextStart.value = true;
    await expect(ensureShellEgressProxy()).rejects.toThrow("start failed (test)");
    expect(currentShellEgressProxyUrl()).toBeNull();

    failNextStart.value = false;
    const proxy = await ensureShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBe(proxy.url);
  });
});

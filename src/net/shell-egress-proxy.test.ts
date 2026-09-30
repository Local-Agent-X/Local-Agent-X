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

// Pass-through by default; lets one test force a start failure, and the race
// tests hold starts pending until released (resolved with a REAL proxy, or
// rejected late) so close()/ensure() interleavings can be constructed exactly.
const failNextStart = { value: false };
const manualStarts: { release: (ok: boolean) => void }[] = [];
const manualMode = { value: false };
vi.mock("./egress-proxy-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./egress-proxy-core.js")>();
  return {
    ...actual,
    startEgressProxy: (options: Parameters<typeof actual.startEgressProxy>[0]) => {
      if (failNextStart.value) return Promise.reject(new Error("start failed (test)"));
      if (!manualMode.value) return actual.startEgressProxy(options);
      return new Promise<Awaited<ReturnType<typeof actual.startEgressProxy>>>((resolve, reject) => {
        manualStarts.push({
          release: (ok) => {
            if (ok) actual.startEgressProxy(options).then(resolve, reject);
            else reject(new Error("late start failure (test)"));
          },
        });
      });
    },
  };
});

import {
  closeShellEgressProxy,
  currentShellEgressProxyUrl,
  ensureShellEgressProxy,
  shellProxyPortRange,
  SHELL_PROXY_PORTS_DEFAULT,
  type ShellEgressProxy,
} from "./shell-egress-proxy.js";

const originalPort = process.env.LAX_PORT;

describe("shellProxyPortRange", () => {
  const original = process.env.LAX_SHELL_PROXY_PORTS;
  afterEach(() => {
    if (original === undefined) delete process.env.LAX_SHELL_PROXY_PORTS;
    else process.env.LAX_SHELL_PROXY_PORTS = original;
  });

  it("defaults to the LAX range, above the one Anthropic's runtime uses", () => {
    delete process.env.LAX_SHELL_PROXY_PORTS;
    expect(shellProxyPortRange()).toEqual(SHELL_PROXY_PORTS_DEFAULT);
    expect(SHELL_PROXY_PORTS_DEFAULT.from).toBeGreaterThan(60089);
  });

  it("honors LAX_SHELL_PROXY_PORTS=from-to and refuses a malformed or unprivileged-hostile value", () => {
    process.env.LAX_SHELL_PROXY_PORTS = "61000-61003";
    expect(shellProxyPortRange()).toEqual({ from: 61000, to: 61003 });
    process.env.LAX_SHELL_PROXY_PORTS = "80-90";
    expect(() => shellProxyPortRange()).toThrow(/1024/);
    process.env.LAX_SHELL_PROXY_PORTS = "61010-61000";
    expect(() => shellProxyPortRange()).toThrow(/from-to/);
    process.env.LAX_SHELL_PROXY_PORTS = "nonsense";
    expect(shellProxyPortRange()).toEqual(SHELL_PROXY_PORTS_DEFAULT);
  });
});

function requestThroughProxy(proxy: ShellEgressProxy, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.url);
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(url.port),
      method: "GET",
      path: target,
      headers: {
        host: new URL(target).host,
        // The token rides in the URL's credentials, as a caged shell's tools send it.
        "proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`,
      },
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
  manualMode.value = false;
  manualStarts.length = 0;
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
    expect(restarted.url).toMatch(/^http:\/\/lax:[0-9a-f]{32}@127\.0\.0\.1:\d+$/);
  });

  it("binds inside the fixed port range with a fresh token per start", async () => {
    const proxy = await ensureShellEgressProxy();
    const range = shellProxyPortRange();
    expect(proxy.port).toBeGreaterThanOrEqual(range.from);
    expect(proxy.port).toBeLessThanOrEqual(range.to);
    const token = new URL(proxy.url).password;
    await closeShellEgressProxy();
    const again = await ensureShellEgressProxy();
    expect(new URL(again.url).password).not.toBe(token);
  });

  it("a request without the token is refused before policy, and is not an audit row", async () => {
    resolve4.mockResolvedValue(["10.0.0.7"]);
    const proxy = await ensureShellEgressProxy();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: proxy.port, method: "GET", path: "http://rebind.example/secret", headers: { host: "rebind.example" } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(407);
    expect(auditRecord).not.toHaveBeenCalled();
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

describe("singleton race guards", () => {
  it("a close() racing a pending start never leaves the dead URL in the mirror", async () => {
    manualMode.value = true;
    const startA = ensureShellEgressProxy();
    const closing = closeShellEgressProxy();

    manualStarts[0].release(true);
    await startA;
    await closing;
    // A resolved after close() had already dropped it: the .then guard must
    // refuse the mirror write, and close() must have shut A's listener down.
    expect(currentShellEgressProxyUrl()).toBeNull();

    manualMode.value = false;
    const proxyB = await ensureShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBe(proxyB.url);
  });

  it("a LATE-rejecting superseded start does not clobber the live successor (catch guard)", async () => {
    manualMode.value = true;
    const startA = ensureShellEgressProxy();
    startA.catch(() => { /* asserted via closing below */ });
    const closing = closeShellEgressProxy();
    closing.catch(() => { /* close() surfaces A's failure; tolerated */ });

    const startB = ensureShellEgressProxy();
    manualStarts[1].release(true);
    const proxyB = await startB;
    expect(currentShellEgressProxyUrl()).toBe(proxyB.url);

    manualStarts[0].release(false);
    await expect(closing).rejects.toThrow("late start failure (test)");
    // Old code nulled sharedProxy + mirror unconditionally here, orphaning B
    // and forcing a spurious third start. The guard must keep B live.
    expect(currentShellEgressProxyUrl()).toBe(proxyB.url);
    expect(await ensureShellEgressProxy()).toBe(proxyB);
    expect(manualStarts).toHaveLength(2);
  });
});

// What a caged shell may reach on loopback is ONE union, read per spawn: this
// instance's live proxy port (the route out), this server's port and the
// registered local services — never the reserved in-app debugging port, which
// the security layer withholds at the source, and never the rest of the proxy
// range, where another instance's proxy would answer under its own policy.
// Linux bridges these ports into the namespace; macOS allows them in the
// seatbelt profile; both read this function.
describe("cageLoopbackPorts — the admitted loopback set every cage reads", () => {
  const prev = { data: process.env.LAX_DATA_DIR, cdp: process.env.LAX_ELECTRON_CDP_PORT };
  let dataDir: string;
  beforeEach(async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    dataDir = mkdtempSync(join(tmpdir(), "lax-cage-ports-"));
    process.env.LAX_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, "security.json"), JSON.stringify({ localServicePorts: [3000, 49123] }));
    process.env.LAX_ELECTRON_CDP_PORT = "49123";
  });
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    if (prev.data === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev.data;
    if (prev.cdp === undefined) delete process.env.LAX_ELECTRON_CDP_PORT; else process.env.LAX_ELECTRON_CDP_PORT = prev.cdp;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("admits the live proxy's port, the self port and the registered services; withholds the reserved debugging port and the rest of the range", async () => {
    const { cageLoopbackPorts, currentShellEgressProxyUrl, ensureShellEgressProxy, shellProxyPortRange } = await import("./shell-egress-proxy.js");
    const range = shellProxyPortRange();
    // No proxy yet: no route out is admitted (fail closed), the rest stands.
    const before = cageLoopbackPorts();
    for (let p = range.from; p <= range.to; p++) expect(before, `proxy port ${p} before start`).not.toContain(p);
    const proxy = await ensureShellEgressProxy();
    const live = Number(new URL(currentShellEgressProxyUrl()!).port);
    expect(live).toBe(proxy.port);
    const ports = cageLoopbackPorts();
    expect(ports).toContain(live);
    for (let p = range.from; p <= range.to; p++) if (p !== live) expect(ports, `sibling range port ${p}`).not.toContain(p);
    expect(ports).toContain(7007); // LAX_PORT, set by this file's beforeEach
    expect(ports).toContain(3000);
    expect(ports).not.toContain(49123);
    expect(new Set(ports).size, "no duplicates").toBe(ports.length);
  });
});

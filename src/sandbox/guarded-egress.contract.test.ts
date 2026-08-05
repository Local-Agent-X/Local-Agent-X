// Cross-seam contract for the guarded egress chain (Jul 23 campaign, chunk C6).
//
// Every piece — the egress-proxy core, the shell proxy singleton + live URL
// mirror, the guarded-mode env overlay, the seatbelt loopback cage, the
// truthful network-denial hints, the shell_egress_denied audit event — is
// unit-green in its own file. This file exists to catch drift AT THE SEAMS:
// it composes the REAL components (real proxy listener, real sandbox-exec
// cage, real audit JSONL under a redirected HOME) and asserts the end-to-end
// contracts the chunks only promised individually.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

// HOME/USERPROFILE must point at a throwaway dir BEFORE importing anything
// that resolves the lax dir (audit trail, config) — same pattern as
// src/threat/approval-idempotency.test.ts. LAX_SANDBOX=guarded is honored at
// CALL time by getSandboxMode (getSelectedSandboxMode reads the env when no
// runtime mode was set), which is what flips shellProxyEnv/shellProxyEnvSync
// into their guarded branch without mocking the sandbox facade.
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  LAX_DATA_DIR: process.env.LAX_DATA_DIR,
  LAX_PORT: process.env.LAX_PORT,
  LAX_SANDBOX: process.env.LAX_SANDBOX,
};
const home = mkdtempSync(join(tmpdir(), "lax-guarded-egress-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.LAX_DATA_DIR;
process.env.LAX_PORT = "7007";
process.env.LAX_SANDBOX = "guarded";

const { closeShellEgressProxy, currentShellEgressProxyUrl, ensureShellEgressProxy } =
  await import("../net/shell-egress-proxy.js");
const { startEgressProxy } = await import("../net/egress-proxy-core.js");
const { shellProxyEnv, shellProxyEnvSync } = await import("../tools/shell-proxy-env.js");
const { wrapForSeatbelt } = await import("./seatbelt.js");
const { networkDenialHint } = await import("./denial-hints.js");
const { isGuardedUsable } = await import("./index.js");

const onDarwin = process.platform === "darwin";
// Live cage probes only run where the guarded kernel backend actually loads.
const liveGate = onDarwin && isGuardedUsable();

// ── shared plumbing ─────────────────────────────────────────────────

interface Listener { port: number; close: () => Promise<void> }
const openListeners: Listener[] = [];
const openCoreProxies: { close: () => Promise<void> }[] = [];
let unwritableDir: string | null = null;

/** Ephemeral UNCONFINED loopback listener the caged/proxied fetches target. */
function startListener(body: string): Promise<Listener> {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.end(body); });
    srv.listen(0, "127.0.0.1", () => {
      const listener: Listener = {
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise<void>((done) => srv.close(() => done())),
      };
      openListeners.push(listener);
      resolve(listener);
    });
  });
}

/**
 * Run a command under the REAL guarded seatbelt cage. Async on purpose: these
 * commands talk to listeners (and the proxy) INSIDE this vitest process, so
 * execFileSync would block the event loop hosting them and deadlock — see the
 * runGuardedAsync note in seatbelt.test.ts.
 */
function cagedRun(command: string, extraEnv: Record<string, string>): Promise<{ out: string }> {
  const { cmd, args } = wrapForSeatbelt("/bin/bash", ["-c", command], home, "guarded");
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf-8", timeout: 10_000, env: { ...process.env, ...extraEnv } },
      (_error, stdout, stderr) => resolve({ out: stdout + stderr }));
  });
}

/** Plain (uncaged) absolute-URI GET through a proxy, as curl would send it. */
function rawProxyRequest(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(new URL(proxyUrl).port),
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

interface AuditRow {
  event?: string;
  reason?: string;
  decision?: string;
  sessionId?: string;
  toolName?: string;
  hash?: string;
}

/** Every row of the temp-HOME audit trail (daily files only — the hash-chain
 *  sidecars `.anchors.jsonl` / `.hmac-v1.marker` are tolerated, not parsed). */
function auditRows(): AuditRow[] {
  const dir = join(home, ".lax", "audit");
  if (!existsSync(dir)) return [];
  const rows: AuditRow[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as AuditRow); } catch { /* tolerate torn line */ }
    }
  }
  return rows;
}

afterEach(async () => {
  await closeShellEgressProxy();
  for (const proxy of openCoreProxies.splice(0)) await proxy.close().catch(() => { /* already down */ });
  for (const listener of openListeners.splice(0)) await listener.close();
  process.env.LAX_PORT = "7007";
  delete process.env.LAX_DATA_DIR;
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (unwritableDir) {
    chmodSync(unwritableDir, 0o700);
    rmSync(unwritableDir, { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// ── C1: the sanctioned route works end-to-end ───────────────────────

describe.skipIf(!liveGate)("guarded egress contract: sanctioned route (cage + env + proxy)", () => {
  it("a caged curl with the real guarded env reaches a loopback listener directly (NO_PROXY seam)", async () => {
    const proxy = await ensureShellEgressProxy();
    const overlay = await shellProxyEnv();
    // The full 8-key overlay, derived from the live proxy — cross-module equality.
    expect(Object.keys(overlay).sort()).toEqual([
      "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
      "all_proxy", "http_proxy", "https_proxy", "no_proxy",
    ].sort());
    expect(overlay.HTTP_PROXY).toBe(proxy.url);
    expect(overlay.NO_PROXY).toContain("127.0.0.1");

    const listener = await startListener("CONTRACT-OK");
    const r = await cagedRun(`/usr/bin/curl -sS --max-time 3 http://127.0.0.1:${listener.port}/ok`, overlay);
    expect(r.out).toContain("CONTRACT-OK");
  });

  it("a caged curl EXPLICITLY through the proxy reaches a sanctioned loopback target (cage→proxy→dial seam)", async () => {
    const proxy = await ensureShellEgressProxy();
    const overlay = await shellProxyEnv();
    const listener = await startListener("CONTRACT-OK");
    // The listener plays the "self server" for this request: selfPort() reads
    // LAX_PORT per request, and canonical policy allows loopback only for the
    // self port or a registered local service. `--noproxy ""` defeats the
    // overlay's own NO_PROXY so the request MUST transit the proxy.
    process.env.LAX_PORT = String(listener.port);
    const r = await cagedRun(
      `/usr/bin/curl -sS --max-time 3 --noproxy "" -x ${proxy.url} http://127.0.0.1:${listener.port}/ok`,
      overlay,
    );
    expect(r.out).toContain("CONTRACT-OK");
  });
});

// ── C2: denied egress is blocked at BOTH layers, truthfully ─────────

describe.skipIf(!liveGate)("guarded egress contract: denied egress at both layers", () => {
  it("proxy route: caged curl to TEST-NET-2 gets the 403 and exactly one shell_egress_denied audit row", async () => {
    const proxy = await ensureShellEgressProxy();
    const overlay = await shellProxyEnv();
    const r = await cagedRun(
      `/usr/bin/curl -sS -o /dev/null -w "HTTP:%{http_code}" --max-time 3 --noproxy "" -x ${proxy.url} http://198.51.100.7/x`,
      overlay,
    );
    expect(r.out).toContain("HTTP:403");

    const denies = auditRows().filter(
      (row) => row.event === "shell_egress_denied" && String(row.reason).includes("198.51.100.7"),
    );
    expect(denies).toHaveLength(1);
    expect(denies[0]).toMatchObject({
      sessionId: "shell-egress-proxy",
      toolName: "bash",
      decision: "block",
    });
    expect(String(denies[0].reason)).toContain("(target: http://198.51.100.7/x)");
    // Hash-chain fields ride along on the real trail.
    expect(denies[0].hash).toBeTruthy();
  });

  it("direct route: the cage's raw /dev/tcp output still matches the guarded hint's anchor", async () => {
    const r = await cagedRun("exec 3<>/dev/tcp/198.51.100.7/80 && echo NET-OK", {});
    expect(r.out).not.toContain("NET-OK");
    expect(r.out.toLowerCase()).toContain("connect: operation not permitted");
    // The seam most likely to drift: the LIVE cage's denial text must keep
    // matching the hint's syscall-context anchor, and the hint must name the
    // sanctioned route the env overlay actually injects.
    const hint = networkDenialHint("guarded", r.out, "darwin");
    expect(hint).not.toBeNull();
    expect(hint).toContain('mode "guarded"');
    expect(hint).toContain("HTTP_PROXY");
  });
});

// ── C3: live-URL mirror contract across modules (sync spawn seam) ───

describe.skipIf(!liveGate)("guarded egress contract: mirror across modules for sync spawns", () => {
  it("mirror and sync env agree while up, and both go dark after close", async () => {
    const proxy = await ensureShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBe(proxy.url);
    const env = shellProxyEnvSync();
    expect(env.HTTP_PROXY).toBe(proxy.url);
    expect(env.https_proxy).toBe(proxy.url);
    expect(env.ALL_PROXY).toBe(proxy.url);

    await closeShellEgressProxy();
    expect(currentShellEgressProxyUrl()).toBeNull();
    // The sync miss returns {} for THIS spawn (fails closed at the cage) while
    // warming the proxy in the background for later spawns…
    expect(shellProxyEnvSync()).toEqual({});
    // …and the warm it kicked off is reaped here so nothing leaks.
    await closeShellEgressProxy();
  });
});

// ── C4: dial failures are 502-class and SILENT to the deny hook ─────

describe("egress proxy core contract: dial failure does not fire onPolicyDeny", () => {
  it("connection-refused on a policy-allowed target is a 502 with zero deny events", async () => {
    // Bind, note the port, close — the subsequent dial gets ECONNREFUSED.
    const dead = await startListener("gone");
    const deadPort = dead.port;
    await dead.close();

    const denials: { target: string; reason: string }[] = [];
    const core = await startEgressProxy({
      selfPort: () => String(deadPort),
      viaTag: "1.1 lax-contract-test",
      onPolicyDeny: (info) => { denials.push(info); },
    });
    openCoreProxies.push(core);

    const r = await rawProxyRequest(core.url, `http://127.0.0.1:${deadPort}/x`);
    expect(r.status).toBe(502);
    // The hook observes policy denials (403 class) ONLY — never network errors.
    expect(denials).toHaveLength(0);
  });
});

// ── C5: a broken audit sink never breaks the deny path ──────────────

describe.skipIf(process.platform === "win32")("guarded egress contract: audit sink failure never breaks the flow", () => {
  it("a denied dial still 403s (and the proxy survives) when the audit dir is unwritable", async () => {
    unwritableDir = mkdtempSync(join(tmpdir(), "lax-audit-deny-"));
    chmodSync(unwritableDir, 0o500);
    // getLaxDir() honors LAX_DATA_DIR at call time; the trail's constructor
    // mkdirs under it and throws EACCES — the deny must still ship.
    process.env.LAX_DATA_DIR = join(unwritableDir, "lax");

    const proxy = await ensureShellEgressProxy();
    const first = await rawProxyRequest(proxy.url, "http://198.51.100.99/x");
    expect(first.status).toBe(403);
    // Proxy survives the audit failure: it keeps serving (and keeps denying).
    const second = await rawProxyRequest(proxy.url, "http://198.51.100.99/x");
    expect(second.status).toBe(403);

    delete process.env.LAX_DATA_DIR;
    // Nothing about the broken-sink denials leaked into the healthy trail.
    expect(auditRows().filter((row) => String(row.reason).includes("198.51.100.99"))).toHaveLength(0);
  });
});

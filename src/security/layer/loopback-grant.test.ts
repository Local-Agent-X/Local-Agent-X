// One grant for loopback ports: what http_request may reach, a shell client
// may reach, except this server's own ports. Each arm is read against the
// real on-disk config, so the two seams cannot drift.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfPort, setSelfPort, shellLoopbackReachable, shellUnixSocketReachable } from "./loopback-grant.js";
import { evaluateEgressForUrl } from "./network-policy.js";
import { setAgentOriginPort } from "./agent-origin-port.js";

let dir: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-loopback-grant-"));
  process.env.LAX_DATA_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
  setAgentOriginPort(null);
});

const security = (cfg: Record<string, unknown>) => writeFileSync(join(dir, "security.json"), JSON.stringify(cfg));
const egress = (port: string) => evaluateEgressForUrl(`http://127.0.0.1:${port}/`, selfPort()).allowed;

describe("the shell and http_request read one grant", () => {
  it("a registered local service: both may; an unregistered port: neither", () => {
    expect(shellLoopbackReachable("5173")).toBe(false);
    expect(egress("5173")).toBe(false);
    security({ localServicePorts: ["5173"] });
    expect(shellLoopbackReachable("5173")).toBe(true);
    expect(egress("5173")).toBe(true);
  });

  it("a disposable sandbox: every port, and every Unix socket", () => {
    const sock = join(dir, "svc.sock");
    writeFileSync(sock, "");
    expect(shellUnixSocketReachable(sock)).toBe(false);
    security({ disposableSandbox: true });
    expect(shellLoopbackReachable("9999")).toBe(true);
    expect(egress("9999")).toBe(true);
    expect(shellUnixSocketReachable(sock)).toBe(true);
  });

  it("elsewhere, a Unix socket only while a process the agent started listens on it", () => {
    expect(shellUnixSocketReachable("/var/run/docker.sock")).toBe(false);
    expect(shellUnixSocketReachable(join(dir, "nothing-here.sock"))).toBe(false);
  });

  it("this server's own ports: http_request as a self-call, the shell never", () => {
    security({ disposableSandbox: true });
    const original = selfPort();
    setSelfPort("7031");
    setAgentOriginPort(53991);
    try {
      expect(egress("7031")).toBe(true);
      expect(shellLoopbackReachable("7031")).toBe(false);
      expect(shellLoopbackReachable("53991")).toBe(false);
    } finally {
      setSelfPort(original);
    }
  });
});

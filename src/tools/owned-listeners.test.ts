import { describe, it, expect, afterEach } from "vitest";
import {
  ownedLoopbackPorts, ownedUnixSockets, parseLsof, parseProcNetUnix, parseProcStat, parsePs, parseWinTable,
  portsOwnedBy, registerOwnedProcess, socketsOwnedBy, unregisterOwnedProcess,
} from "./owned-listeners.js";
import { evaluateWebFetch } from "../security/layer/network-policy.js";

describe("portsOwnedBy — a port is the agent's when its listener descends from a process_start session", () => {
  // bash(100) → npm(200) → node(300) listening on 2024; an unrelated app(900) on 5432.
  const procs = [
    { pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 300, ppid: 200 }, { pid: 900, ppid: 1 },
  ];
  const listeners = [{ port: 2024, pid: 300 }, { port: 5432, pid: 900 }, { port: 7007, pid: 1 }];

  it("includes a port held by a descendant of the session, and nothing else", () => {
    expect([...portsOwnedBy(listeners, procs, new Set([100]))]).toEqual(["2024"]);
  });

  it("a session that owns nothing yields nothing", () => {
    expect(portsOwnedBy(listeners, procs, new Set([555])).size).toBe(0);
    expect(portsOwnedBy(listeners, procs, new Set()).size).toBe(0);
  });

  it("survives a parent cycle in a stale process table", () => {
    const cyclic = [{ pid: 300, ppid: 200 }, { pid: 200, ppid: 300 }];
    expect(portsOwnedBy(listeners, cyclic, new Set([100])).size).toBe(0);
  });
});

describe("the OS tables are parsed into listeners and a parent map", () => {
  it("parses the Windows two-section script output", () => {
    const t = parseWinTable("L 2024 300\r\nL 7007 12\r\nP 300 200\r\nP 200 100\r\nnoise\r\n");
    expect(t.listeners).toEqual([{ port: 2024, pid: 300 }, { port: 7007, pid: 12 }]);
    expect(t.procs).toEqual([{ pid: 300, ppid: 200 }, { pid: 200, ppid: 100 }]);
  });

  it("parses lsof -F pn and ps -eo pid=,ppid=", () => {
    expect(parseLsof("p300\nn127.0.0.1:2024\nn[::1]:2024\np900\nn*:5432\n")).toEqual([
      { port: 2024, pid: 300 }, { port: 2024, pid: 300 }, { port: 5432, pid: 900 },
    ]);
    expect(parsePs("  300   200\n  200   100\n")).toEqual([{ pid: 300, ppid: 200 }, { pid: 200, ppid: 100 }]);
  });
});

describe("ownedLoopbackPorts — no live session, no query", () => {
  afterEach(() => unregisterOwnedProcess(424242));

  it("is empty when nothing is registered", () => {
    expect(ownedLoopbackPorts().size).toBe(0);
  });

  it("registering a pid that owns no listener yields nothing (and never throws)", () => {
    registerOwnedProcess(424242);
    expect(ownedLoopbackPorts().size).toBe(0);
  });
});

// TB2 qemu-alpine-ssh, 2026-10-27: a python one-liner driving the console of
// the VM the agent had started (`qemu … -serial unix:/tmp/alpine-serial.sock`)
// was refused as raw network use.
describe("ownedUnixSockets — a socket is the agent's when a process it started listens on it", () => {
  const procs = [{ pid: 100, ppid: 1 }, { pid: 300, ppid: 100 }, { pid: 900, ppid: 1 }];
  const listeners = [{ path: "/tmp/vm.sock", pid: 300 }, { path: "/var/run/docker.sock", pid: 900 }, { path: "@abstract", pid: 300 }];

  it("includes a socket a descendant of the session listens on, never another process's", () => {
    expect([...socketsOwnedBy(listeners, procs, new Set([100]))]).toEqual(["/tmp/vm.sock"]);
    expect(socketsOwnedBy(listeners, procs, new Set([555])).size).toBe(0);
  });

  it("reads only LISTENING, file-backed sockets from /proc/net/unix", () => {
    const table = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 4101 /tmp/vm.sock",
      "0000000000000000: 00000003 00000000 00000000 0001 03 4102 /var/run/docker.sock",
      "0000000000000000: 00000002 00000000 00010000 0001 01 4103 @/tmp/.X11-unix/X0",
      "0000000000000000: 00000002 00000000 00000000 0002 01 4104",
      "0000000000000000: 00000002 00000000 00010000 0001 01 4105 /tmp/with space.sock",
    ].join("\n");
    expect([...parseProcNetUnix(table)]).toEqual([["4101", "/tmp/vm.sock"], ["4105", "/tmp/with space.sock"]]);
  });

  it("reads the parent pid after the command name, whatever it holds", () => {
    expect(parseProcStat("300 (qemu-system-x86) S 100 300 1 0")).toBe(100);
    expect(parseProcStat("301 (a (b) c) S 42 301 1 0")).toBe(42);
  });

  it.runIf(process.platform === "linux")("finds a socket this process listens on once it is registered", async () => {
    const { createServer } = await import("node:net");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lax-owned-sock-"));
    const path = join(dir, "svc.sock");
    const server = createServer();
    await new Promise<void>((done) => server.listen(path, done));
    try {
      expect(ownedUnixSockets().has(path)).toBe(false);
      registerOwnedProcess(process.pid);
      expect(ownedUnixSockets().has(path)).toBe(true);
    } finally {
      unregisterOwnedProcess(process.pid);
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 2026-09-25: `http_request {"url":"http://127.0.0.1:2024/ok"}` was refused 17
// times while the agent's own `langgraph dev` listened on 2024.
describe("the network policy admits a port a process_start session holds", () => {
  const none = new Set<string>();
  it("allows 127.0.0.1:2024 once 2024 is among the local service ports, and names the real path when it is not", () => {
    const owned = new Set(["2024"]);
    expect(evaluateWebFetch(none, false, "7007", "http://127.0.0.1:2024/ok", "permissive", owned).allowed).toBe(true);
    const denied = evaluateWebFetch(none, false, "7007", "http://127.0.0.1:2024/ok", "permissive", none);
    expect(denied.allowed).toBe(false);
    expect(denied.recovery).toMatch(/process_start/);
    expect(denied.recovery).not.toMatch(/add its port to/);
    // The port opens loopback only: the same port on another host is still private-range.
    expect(evaluateWebFetch(none, false, "7007", "http://192.168.1.20:2024/ok", "permissive", owned).allowed).toBe(false);
  });
});

import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeSocketPath, startShellEgressBridge, sweepStaleBridgeSockets } from "./shell-egress-bridge.js";

const posix = process.platform !== "win32";
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tcpEcho(): Promise<number> {
  const s = createServer((c) => c.on("data", (d) => c.write(`TCP:${d.toString().trim()}`)));
  servers.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => { const a = s.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
}

function ask(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath);
    c.once("error", reject);
    c.on("data", (d) => { resolve(d.toString()); c.destroy(); });
    c.on("connect", () => c.write(line));
  });
}

describe.skipIf(!posix)("shell egress bridge", () => {
  it("forwards a unix-socket connection to the proxy's loopback port and unlinks on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const port = await tcpEcho();
    const bridge = await startShellEgressBridge(port, bridgeSocketPath(dir));
    expect(bridge.port).toBe(port);
    expect(bridge.socketPath).toBe(join(dir, `shell-egress-${process.pid}.sock`));
    expect(await ask(bridge.socketPath, "ping")).toBe("TCP:ping");
    await bridge.close();
    expect(existsSync(bridge.socketPath)).toBe(false);
  });

  it("sweeps sockets of processes that are gone and keeps the live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const dead = bridgeSocketPath(dir, 999_999_9);
    writeFileSync(dead, "");
    const port = await tcpEcho();
    const bridge = await startShellEgressBridge(port, bridgeSocketPath(dir));
    sweepStaleBridgeSockets(dir);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(bridge.socketPath)).toBe(true);
    await bridge.close();
  });
});

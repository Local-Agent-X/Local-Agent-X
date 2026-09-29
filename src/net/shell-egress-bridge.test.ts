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

function tcpEcho(tag: string): Promise<number> {
  const s = createServer((c) => c.on("data", (d) => c.write(`${tag}:${d.toString().trim()}`)));
  servers.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => { const a = s.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
}

/** Connect as the forwarder does: name the port, then send the payload. Resolves with
 *  the first reply, or "CLOSED" when the bridge hangs up without answering. */
function ask(socketPath: string, port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath);
    c.once("error", reject);
    c.on("data", (d) => { resolve(d.toString()); c.destroy(); });
    c.on("close", () => resolve("CLOSED"));
    c.on("connect", () => { c.write(`${port}\n`); c.write(line); });
  });
}

describe.skipIf(!posix)("shell egress bridge", () => {
  it("forwards a connection that names the proxy's port, and unlinks on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const port = await tcpEcho("PROXY");
    const bridge = await startShellEgressBridge(port, bridgeSocketPath(dir));
    expect(bridge.port).toBe(port);
    expect(bridge.socketPath).toBe(join(dir, `shell-egress-${process.pid}.sock`));
    expect(await ask(bridge.socketPath, port, "ping")).toBe("PROXY:ping");
    await bridge.close();
    expect(existsSync(bridge.socketPath)).toBe(false);
  });

  it("admits another loopback port only when the policy says so, and refuses silently otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const proxyPort = await tcpEcho("PROXY");
    const registered = await tcpEcho("DEV");
    const stray = await tcpEcho("STRAY");
    const bridge = await startShellEgressBridge(proxyPort, bridgeSocketPath(dir), (p) => p === registered);
    expect(await ask(bridge.socketPath, registered, "hello")).toBe("DEV:hello");
    expect(await ask(bridge.socketPath, stray, "hello")).toBe("CLOSED");
    // The preamble and the payload arriving in one write still split correctly.
    const joined = await new Promise<string>((resolve, reject) => {
      const c = connect(bridge.socketPath);
      c.once("error", reject);
      c.on("data", (d) => { resolve(d.toString()); c.destroy(); });
      c.on("connect", () => c.write(`${registered}\nsame-chunk`));
    });
    expect(joined).toBe("DEV:same-chunk");
    await bridge.close();
  });

  it("drops a connection that never names a port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const bridge = await startShellEgressBridge(await tcpEcho("PROXY"), bridgeSocketPath(dir));
    const outcome = await new Promise<string>((resolve) => {
      const c = connect(bridge.socketPath);
      c.on("data", () => resolve("ANSWERED"));
      c.on("close", () => resolve("CLOSED"));
      c.on("connect", () => c.write("no newline here at all"));
    });
    expect(outcome).toBe("CLOSED");
    await bridge.close();
  });

  it("sweeps sockets of processes that are gone and keeps the live ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-bridge-"));
    dirs.push(dir);
    const dead = bridgeSocketPath(dir, 999_999_9);
    writeFileSync(dead, "");
    const port = await tcpEcho("PROXY");
    const bridge = await startShellEgressBridge(port, bridgeSocketPath(dir));
    sweepStaleBridgeSockets(dir);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(bridge.socketPath)).toBe(true);
    await bridge.close();
  });
});

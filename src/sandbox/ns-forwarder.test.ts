// The in-cage forwarder, run the way bwrap runs it (node -e <source> …) but
// without bwrap, so the launcher mechanics — listen, forward to the unix
// socket, start the target with stdio through, exit with its code — are
// pinned on every POSIX host, not only where a cage can be built.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NS_FORWARDER_SOURCE } from "./ns-forwarder-source.js";

const posix = process.platform !== "win32";
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A unix-socket server that answers every line with UPSTREAM:<line>. */
function echoOnSocket(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lax-nsf-"));
  dirs.push(dir);
  const path = join(dir, "s");
  const server = createServer((c) => { c.on("data", (d) => c.write(`UPSTREAM:${d.toString().trim()}\n`)); });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => { const a = s.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(socketPath: string, port: number, target: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", NS_FORWARDER_SOURCE, "--", socketPath, String(port), "--", ...target], { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) => resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0, out: stdout + stderr }));
  });
}

describe.skipIf(!posix)("ns-forwarder", () => {
  it("listens on the port, forwards to the unix socket, and runs the target with stdio through", async () => {
    const sock = await echoOnSocket();
    const port = await freePort();
    const r = await run(sock, port, ["/bin/bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}; echo hello >&3; read -t 3 line <&3; echo "GOT:$line"`]);
    expect(r.out).toContain("GOT:UPSTREAM:hello");
    expect(r.code).toBe(0);
  });

  it("exits with the target's exit code", async () => {
    const sock = await echoOnSocket();
    const r = await run(sock, await freePort(), ["/bin/sh", "-c", "exit 7"]);
    expect(r.code).toBe(7);
  });

  it("still runs the target when the port cannot be bound, and says the shell has no route", async () => {
    const sock = await echoOnSocket();
    const taken = createServer();
    servers.push(taken);
    const port = await new Promise<number>((resolve) => taken.listen(0, "127.0.0.1", () => { const a = taken.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
    const r = await run(sock, port, ["/bin/sh", "-c", "echo RAN"]);
    expect(r.out).toContain("RAN");
    expect(r.out).toContain("no egress bridge");
  });
});

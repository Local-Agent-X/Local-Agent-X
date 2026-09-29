// The in-cage forwarder, run the way bwrap runs it (node -e <source> …) but
// without bwrap, so the launcher mechanics — listen on each port, name the
// port to the unix socket, forward, start the target with stdio through, exit
// with its code — are pinned on every POSIX host, not only where a cage can
// be built.
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

/** A unix-socket server speaking the bridge's protocol: the first line names
 *  the port (answered `PRE:<port>`), every later line is answered `UPSTREAM:<line>`. */
function echoOnSocket(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lax-nsf-"));
  dirs.push(dir);
  const path = join(dir, "s");
  const server = createServer((c) => {
    let head = "";
    let named = false;
    c.on("data", (d) => {
      let text = d.toString();
      if (!named) {
        head += text;
        const nl = head.indexOf("\n");
        if (nl === -1) return;
        named = true;
        c.write(`PRE:${head.slice(0, nl)}\n`);
        text = head.slice(nl + 1);
        if (!text.trim()) return;
      }
      c.write(`UPSTREAM:${text.trim()}\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => { const a = s.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(socketPath: string, ports: number[], target: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", NS_FORWARDER_SOURCE, "--", socketPath, ports.join(","), "--", ...target], { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) => resolve({ code: error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0, out: stdout + stderr }));
  });
}

/** A bash body that dials `port`, sends `word`, and prints the preamble echo and the reply. */
const dial = (port: number, word: string) =>
  `exec 3<>/dev/tcp/127.0.0.1/${port}; echo ${word} >&3; read -t 3 pre <&3; read -t 3 line <&3; echo "PRE=$pre LINE=$line"; exec 3>&-`;

describe.skipIf(!posix)("ns-forwarder", () => {
  it("listens on the port, names it to the unix socket, forwards, and runs the target with stdio through", async () => {
    const sock = await echoOnSocket();
    const port = await freePort();
    const r = await run(sock, [port], ["/bin/bash", "-c", dial(port, "hello")]);
    expect(r.out).toContain(`PRE=PRE:${port} LINE=UPSTREAM:hello`);
    expect(r.code).toBe(0);
  });

  it("listens on every registered port too, naming each on its own connections", async () => {
    const sock = await echoOnSocket();
    const proxy = await freePort();
    const dev = await freePort();
    const r = await run(sock, [proxy, dev], ["/bin/bash", "-c", `${dial(proxy, "a")}; ${dial(dev, "b")}`]);
    expect(r.out).toContain(`PRE=PRE:${proxy} LINE=UPSTREAM:a`);
    expect(r.out).toContain(`PRE=PRE:${dev} LINE=UPSTREAM:b`);
  });

  it("exits with the target's exit code", async () => {
    const sock = await echoOnSocket();
    const r = await run(sock, [await freePort()], ["/bin/sh", "-c", "exit 7"]);
    expect(r.code).toBe(7);
  });

  it("still runs the target when the proxy port cannot be bound, and says the shell has no route", async () => {
    const sock = await echoOnSocket();
    const taken = createServer();
    servers.push(taken);
    const port = await new Promise<number>((resolve) => taken.listen(0, "127.0.0.1", () => { const a = taken.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
    const r = await run(sock, [port], ["/bin/sh", "-c", "echo RAN"]);
    expect(r.out).toContain("RAN");
    expect(r.out).toContain("no egress bridge");
  });

  it("a registered port that cannot be bound is reported and does not stop the shell", async () => {
    const sock = await echoOnSocket();
    const taken = createServer();
    servers.push(taken);
    const busy = await new Promise<number>((resolve) => taken.listen(0, "127.0.0.1", () => { const a = taken.address(); resolve(typeof a === "object" && a ? a.port : 0); }));
    const r = await run(sock, [await freePort(), busy], ["/bin/sh", "-c", "echo RAN"]);
    expect(r.out).toContain("RAN");
    expect(r.out).toContain(`cannot listen on 127.0.0.1:${busy}`);
    expect(r.out).not.toContain("no egress bridge");
  });
});

// The host half of the Linux egress bridge: a unix socket that forwards to
// loopback ports on the host. A guarded shell on Linux lives in an empty
// network namespace, so the host's ports do not exist for it; the socket file
// is bind-mounted into the cage, where ns-forwarder-source.ts listens on the
// proxy's port and on each registered local-service port and forwards here.
// Every connection opens with the port it was accepted on, and this side
// decides: the proxy's port always, any other only when the same policy that
// sanctions it for http_request does. One socket per LAX process (the pid is
// in the name) so two instances never share a file.
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";

export interface ShellEgressBridge {
  socketPath: string;
  port: number;
  close: () => Promise<void>;
}

const SOCKET_PREFIX = "shell-egress-";
/** Longest preamble the forwarder ever writes: five digits and a newline. */
const PREAMBLE_MAX = 6;

/** `<runDir>/shell-egress-<pid>.sock`. Kept short: unix socket paths cap at 108 bytes. */
export function bridgeSocketPath(runDir: string, pid = process.pid): string {
  return join(runDir, `${SOCKET_PREFIX}${pid}.sock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove sockets left by LAX processes that are gone (a crash never unlinks). */
export function sweepStaleBridgeSockets(runDir: string): void {
  if (!existsSync(runDir)) return;
  for (const name of readdirSync(runDir)) {
    const m = new RegExp(`^${SOCKET_PREFIX}(\\d+)\\.sock$`).exec(name);
    if (!m || pidAlive(Number(m[1]))) continue;
    try { unlinkSync(join(runDir, name)); } catch { /* raced with another sweep */ }
  }
}

/** Read the `<port>\n` preamble, then hand the rest of the stream to `onPort`. */
function readPreamble(client: Socket, onPort: (port: number, rest: Buffer) => void): void {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(0x0a);
    if (nl === -1) {
      if (head.length > PREAMBLE_MAX) client.destroy();
      return;
    }
    client.off("data", onData);
    client.pause();
    const port = Number(head.subarray(0, nl).toString());
    if (!Number.isInteger(port) || port < 1 || port > 65535) { client.destroy(); return; }
    onPort(port, head.subarray(nl + 1));
  };
  client.on("data", onData);
}

/**
 * `port` is the proxy's, admitted unconditionally; any other port a
 * connection names is admitted only when `allowPort` says so, and is refused
 * (the connection closed with nothing sent) otherwise.
 */
export function startShellEgressBridge(port: number, socketPath: string, allowPort: (port: number) => boolean = () => false): Promise<ShellEgressBridge> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) unlinkSync(socketPath); // ours from an earlier start in this process
  const server = createServer((client) => {
    client.on("error", () => { /* the peer went away mid-preamble */ });
    readPreamble(client, (target, rest) => {
      if (target !== port && !allowPort(target)) { client.destroy(); return; }
      const upstream = connect({ host: "127.0.0.1", port: target });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      if (rest.length) upstream.write(rest);
      client.pipe(upstream).pipe(client);
      client.resume();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* the run dir is already 0700 */ }
      resolve({
        socketPath,
        port,
        close: () => new Promise<void>((done) => server.close(() => {
          try { unlinkSync(socketPath); } catch { /* already gone */ }
          done();
        })),
      });
    });
  });
}

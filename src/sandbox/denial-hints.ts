/**
 * Truthful agent-facing notices for kernel-cage denials.
 *
 * When the sandbox (guarded/seatbelt/bwrap) denies a syscall, the raw shell
 * output reads as a mystery failure ("Operation not permitted") and the agent
 * flails or — worse — reports a lie ("the file is corrupt", "the host is
 * down"). These helpers map a denial to a one-line notice naming the REAL
 * layer and the recovery path. Campaign invariant (Jul 23 audit): never lie
 * about why something was blocked — so every hint is gated on evidence that
 * the cage, and not an ordinary error, produced the output, and every claim
 * in every message variant must be true for the mode+platform it fires in.
 *
 * Notices go only in the agent-facing content; meta.stderr stays raw.
 */
import type { SandboxMode } from "./types.js";
import { HOME_RELATIVE_DENY_DIRS, HOME_RELATIVE_DENY_FILES, GUARDED_SCOPE_EXEMPT_DIRS } from "./validate.js";

/**
 * When a bash command fails because the active kernel cage denied a credential
 * dir, return a one-line notice mapping the raw "Operation not permitted" to the
 * sandbox + its off switch; null otherwise. Now that "guarded" is the DEFAULT,
 * real users hit this (e.g. `aws s3 ls` → ~/.aws denied) and the bare EPERM reads
 * as a mystery failure. Gated on BOTH a permission-denial phrase AND a reference
 * to a path the active mode actually denies (guarded exempts ~/.config), so an
 * ordinary permission error is never mislabeled as the sandbox. The notice goes
 * only in the agent-facing content; meta.stderr stays the raw output. Mirrors the
 * docker-mode notice in shell-tool.ts.
 */
export function sandboxDenialHint(mode: SandboxMode, output: string): string | null {
  if (mode !== "guarded" && mode !== "seatbelt" && mode !== "bwrap") return null;
  if (!/operation not permitted|permission denied/i.test(output)) return null;
  const exempt = mode === "guarded" ? GUARDED_SCOPE_EXEMPT_DIRS : new Set<string>();
  const hit = HOME_RELATIVE_DENY_DIRS.find((d) => !exempt.has(d) && output.includes(`/${d}`))
    ?? HOME_RELATIVE_DENY_FILES.find((f) => output.includes(`/${f}`));
  if (!hit) return null;
  return `[sandbox: blocked by the bash kernel cage (mode "${mode}") — it denies credential paths like ~/${hit} at the OS level, so this is the sandbox, not a real file error. If the user needs this command, they can turn the bash sandbox Off in Settings → Security; offer that rather than disabling it yourself.]`;
}

// Connect-context EPERM anchors. Every anchor is live-verified against the
// macOS cage (raw captures in denial-hints.test.ts fixtures) AND shaped so no
// FILE-layer EPERM can match it: an earlier loose form
// (`connect(?:ion)?\b[^\n]{0,80}operation not permitted`) word-boundary-matched
// the `.` in `connect.sh`, so `rm: connect.sh: Operation not permitted` (uchg
// flag / root-owned file / TCC prose) fabricated a network-cage message for a
// file denial — a lie under the Jul 23 invariant. Each anchor now requires the
// emitting program's own syscall-error format, which a filename cannot forge:
//  - shell /dev/tcp: bash prints `<argv0>: connect: Operation not permitted`
//    (live: "/bin/bash: connect: Operation not permitted"). Anchored on the
//    sh-family argv0 prefix + optional bash `line N:` marker; `rm: connect:`,
//    `touch: connect.sh:` and `chmod: … on connection-helper.sh:` all fail the
//    `sh: connect: ` sequence. The old `(?:ion)?` variant is DROPPED: no tool
//    surveyed under the live cage (bash, zsh, ssh, nc, git, python, node, ruby)
//    emits "connection: Operation not permitted" — only prose does (e.g. TCC's
//    "Connection to backup volume failed: Operation not permitted"), which is
//    exactly the false positive. zsh has no /dev/tcp emulation (live: "no such
//    file or directory"), but the prefix is kept for sh-in-zsh-clothing setups.
//  - ssh (and scp/sftp, which shell out to it): `ssh: connect to host <h> port
//    <n>: Operation not permitted` (live capture) — full fixed phrase + port.
//  - node/libuv: `connect EPERM <addr>` (live: "Error: connect EPERM
//    192.0.2.1:80 - Local (0.0.0.0:0)") — case-SENSITIVE errno signature.
//  - ruby/C strerror-first: `Operation not permitted - connect(2)` (live ruby
//    TCPSocket capture) — reversed word order, unforgeable by `rm: <path>:`.
// Deliberately NOT anchors: curl — curl 8.x prints the identical "curl: (7) …
// Couldn't connect to server" for a cage EPERM and for a genuinely refused
// live port (verified side by side), so curl output cannot be truthfully
// attributed to the cage. Plain "Connection refused" is a live-but-refusing
// listener and must never be blamed on the sandbox. git:// is a known gap: git
// splits "unable to connect to <host>:" and "errno=Operation not permitted"
// across lines and was never matched by the old anchor either.
const SHELL_CONNECT_EPERM_RE = /\b(?:ba|z|da)?sh: (?:line \d+: )?connect: operation not permitted/i;
const SSH_CONNECT_EPERM_RE = /\bssh: connect to host [^\n]{1,256} port \d+: operation not permitted/i;
const NODE_CONNECT_EPERM_RE = /\bconnect EPERM\b/; // case-sensitive: libuv errno token
const C_CONNECT_EPERM_RE = /operation not permitted - connect\(2\)/i;
// python: `sock.connect(sa)` traceback frame, then `PermissionError: [Errno 1]
// Operation not permitted`. Python 3.13+ inserts fine-grained-traceback marker
// lines (`    ~~~~~~~~~~~~^^^^`) between the frame and the exception (live
// 3.14.6 capture in the test fixtures), so up to two marker-only lines are
// tolerated; the ≤3.12 adjacent-line form still matches with zero. Errno 1 is
// required: a file-layer python EPERM has no `.connect(` frame line at all.
const PY_CONNECT_EPERM_RE =
  /\.connect\([^\n]*\n(?:[ \t~^]+\n){0,2}[^\n]*permissionerror: \[errno 1\] operation not permitted/i;
// bwrap's --unshare-net surfaces as no-route, not EPERM: strict bwrap puts the
// shell in an isolated network namespace, so connect() reports unreachable —
// under that mode the missing route IS the cage. Gated to bwrap only; in every
// other mode "Network is unreachable" is a real host networking problem. No
// filename hole here (file ops cannot produce ENETUNREACH), but the trailing
// `\b` (was `connect(?:ion)?`) drops prose like "Connection to db failed:
// Network is unreachable" while keeping bash's `connect: Network is
// unreachable` and ssh's `connect to host … : Network is unreachable`.
const CONNECT_UNREACH_RE = /\bconnect\b[^\n]{0,80}network is unreachable/i;

/**
 * When a caged command's NETWORK attempt was denied by the kernel cage, return
 * a one-line notice naming the real layer + the sanctioned route; null
 * otherwise. Companion to sandboxDenialHint (file denials) — same seam, same
 * append mechanics in shell-tool.ts.
 *
 * Truthfulness gates:
 *  - Fires only under a cage mode, and only on connect-context EPERM (or, for
 *    bwrap, netns-unreachable) — never on generic network failure.
 *  - Guarded network confinement currently ships only via seatbelt (darwin).
 *    Linux guarded keeps the host network namespace (no --unshare-net — see
 *    bwrap.ts guarded scope), so on non-darwin platforms guarded must stay
 *    silent: a connect failure there is real and the cage must not take credit.
 *  - The guarded message claims loopback works + proxy route exists (true on
 *    darwin guarded); the strict messages claim neither.
 */
export function networkDenialHint(
  mode: SandboxMode,
  output: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (mode !== "guarded" && mode !== "seatbelt" && mode !== "bwrap") return null;
  if (mode === "guarded" && platform !== "darwin") return null;
  const epermHit =
    SHELL_CONNECT_EPERM_RE.test(output) ||
    SSH_CONNECT_EPERM_RE.test(output) ||
    NODE_CONNECT_EPERM_RE.test(output) ||
    C_CONNECT_EPERM_RE.test(output) ||
    PY_CONNECT_EPERM_RE.test(output);
  const unreachHit = mode === "bwrap" && CONNECT_UNREACH_RE.test(output);
  if (!epermHit && !unreachHit) return null;
  if (mode === "guarded") {
    return `[sandbox: connection blocked by the bash network cage (mode "guarded") — guarded shells reach loopback directly, but anything off-machine must go through the injected HTTP_PROXY/HTTPS_PROXY egress proxy, which applies the app's egress policy; this is the sandbox, not the remote host being down. Retry with a tool that honors the proxy env (curl/git/npm do), or use the native http_request tool. If the user needs direct shell network, they can change the sandbox mode in Settings → Security (or LAX_SANDBOX=host); offer that rather than disabling it yourself.]`;
  }
  const confinement = mode === "seatbelt"
    ? "it denies ALL shell network at the OS level, loopback included"
    : "it runs the shell in an isolated network namespace (--unshare-net), so nothing off-machine and no host loopback service is reachable";
  return `[sandbox: connection blocked by the bash network cage (mode "${mode}") — ${confinement}; this is the sandbox, not the remote host being down. No proxy route exists in this strict mode; use the native http_request tool for HTTP(S). If the user needs shell network, they can change the sandbox mode in Settings → Security (or LAX_SANDBOX=host); offer that rather than disabling it yourself.]`;
}

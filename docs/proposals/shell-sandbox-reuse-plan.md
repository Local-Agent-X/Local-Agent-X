# Shell sandbox: reuse Anthropic's runtime pieces, keep LAX's policy

Date: 2026-09-28. Decision memo for the shell-safety queue (steps 2 and 4:
Linux egress through the proxy, Windows network cage). Facts below were read
from the published package (`@anthropic-ai/sandbox-runtime` 0.0.77, installed
in a scratch folder) and its source on GitHub; nothing here is from memory.
`[UNVERIFIED]` marks the two claims that still need a live run.

## The question

Before building a Linux network-namespace helper and a Windows cage by hand,
can LAX vendor Anthropic's sandbox runtime (`srt`) as its one cage, the way
`arikernel` is vendored, and get macOS, Linux and Windows from one maintained
upstream?

## What srt is (verified)

- Apache-2.0, Node >= 20.11, 8.4 MB installed, four small dependencies
  (a SOCKS5 server, commander, node-forge, zod).
- **macOS:** `sandbox-exec` with a generated seatbelt profile. Network is
  deny-by-default with the runtime's own HTTP and SOCKS proxies on loopback
  ports; unix sockets are denied unless allowlisted (`allowUnixSockets`,
  written as `(remote unix-socket (subpath …))`). Filesystem writes are
  allow-only (`allowWrite`), reads deny-then-allow.
- **Linux:** bubblewrap with `--unshare-net`, `--unshare-pid`, `--unshare-user`,
  read-only root, tmpfs over denied paths. The network bridge is `socat`
  listening inside the namespace on 3128/1080 and forwarding over bind-mounted
  unix sockets to the host proxies. A bundled `apply-seccomp` binary restricts
  socket access after the bridge is up. Requires `bwrap` and `socat` (and
  `ripgrep` for its mandatory-deny scan).
- **Windows (alpha):** a bundled `srt-win.exe` helper. One UAC prompt
  (`srt windows-install`) provisions a hidden `srt-sandbox` local user and
  installs machine-wide WFP filters keyed to that user's SID: block egress,
  permit loopback to a proxy port range (default 60080–60089). Each run is
  unelevated: broker → `CreateProcessWithLogonW` → restricted token in a job
  object, fresh profile environment, additive NTFS ACEs for the sandbox SID on
  the working tree. Documented limits: per-user tool installs (nvm, per-user
  winget) are unreachable; the proxy token is visible in the runner command
  line; DNS through the system resolver is not fenced; CryptoAPI revocation
  fetches bypass the proxy.
- **Library API:** `SandboxManager.initialize(config)` starts the proxies and
  (on Windows) applies ACLs; `wrapWithSandbox(command)` returns a shell string
  on macOS/Linux; `wrapWithSandboxArgv(command)` returns `{argv, env}` on
  Windows; `updateConfig` swaps network rules live; `SandboxAskCallback` and a
  violation store surface denials.

## Why wholesale adoption does not fit

1. **Its policy model is allowlist-only.** `allowedDomains` rejects a bare
   `*` outright: "Overly broad patterns like `*.com` or `*` are not allowed
   for security reasons" (`dist/sandbox/sandbox-config.js`). LAX's default
   egress posture is permissive with guards: any host except loopback, link-
   local, metadata and the operator's denylist, every request audited, with
   registered local-service ports. Adopting srt's proxy would force every LAX
   user to enumerate the domains their agent may reach. That is a product
   change nobody asked for.
2. **The cage and the proxy are one unit.** Every srt profile permits only
   srt's own proxy ports (macOS) or its own bridge sockets (Linux). LAX's
   proxy cannot sit behind it: srt refuses to dial loopback or this host's
   own addresses, by design. So LAX cannot take the cage and keep its proxy.
3. **The Windows helper ships unsigned.** Both `vendor/srt-win/{x64,arm64}/
   srt-win.exe` report `NotSigned`, and the Rust source is in the GitHub repo
   (`vendor/srt-win-src`), not the npm package. An unsigned helper launched by
   a signed installer is the exact shape that Defender and third-party AV
   quarantine on LAX installs today. Shipping it means building and signing
   it ourselves either way.
4. **macOS is the one platform where LAX is already ahead.** LAX's guarded
   profile has denied off-machine network since August, admits only the
   registered loopback ports (as of 2026-09-30 — the same union Linux
   bridges and the proxy judges by) and allowlists unix sockets in the same
   shape srt does. Replacing it would change the write posture (allow-only)
   for no security gain.

## What is worth reusing

- **The Windows helper, as a helper.** `srt-win.exe` provisions the user and
  the WFP fence and launches a process as that user with an env overlay. It
  does not require srt's proxy: the WFP permit is a loopback port range, and
  whatever listens there is reached. LAX's own proxy, bound inside that
  range and requiring a token (the permit is not SID-scoped), is the sanctioned
  route. This is the Windows cage from the 2026-09-27 research with the
  helper's first year of escape testing done by someone else. Build and sign
  it from their source for the installer; drive it from `wrapSpawnForSandbox`.
- **The Linux bridge design.** `--unshare-net` plus a loopback listener inside
  the namespace forwarding over a bind-mounted unix socket, then seccomp. LAX
  can do the forwarding with a small Node helper instead of `socat` (one
  fewer package for users) and keep `bwrap.ts` as the canonical. Their
  `apply-seccomp` source is the reference for the filter.
- **Their escape list** as LAX's Windows phase-3 matrix (surrogate spawns via
  schtasks, BITS, RunAs, parent-process spoofing are closed structurally by
  the separate user; named pipes and DNS are not).

## Recommendation

Do not vendor the runtime. Reuse its Windows helper and its Linux bridge
design behind LAX's existing seams (`src/sandbox/index.ts`
`wrapSpawnForSandbox`, `src/tools/shell-proxy-env.ts`, `src/net/
shell-egress-proxy.ts`), and keep LAX's egress policy, proxy and audit as the
one policy layer for browser, server and shell.

Order of work, each step shippable on its own:

1. **Proxy prerequisites (all OS, no admin) — this commit.** The shell proxy
   binds a fixed loopback port range instead of an ephemeral port, fails
   closed when it cannot own a port there, requires a per-process token in the
   proxy URL (`Proxy-Authorization`, 407 without it), and the guarded env
   sets `NODE_USE_ENV_PROXY=1` so Node's `fetch` and `http` honor it. Nothing
   changes for the browser proxy. On Windows nothing changes yet: guarded is
   unavailable there, so no proxy env is injected.
2. **Linux CI job.** A GitHub Actions `ubuntu-latest` job with `bubblewrap`
   installed that runs `src/sandbox` and the guarded egress contract. This is
   the Linux environment the queue was blocked on; it needs no WSL on the
   dev box. `[UNVERIFIED]` that the runner allows unprivileged user
   namespaces; if it does not, the job runs the strict-mode probes only and
   says so.
3. **Linux guarded egress (step 2).** `bwrap.ts` guarded adds `--unshare-net`
   with a Node forwarder over a bind-mounted unix socket to the shell proxy,
   then the seccomp filter. The network regex denylist entries are deleted on
   Linux once the contract test proves the route, exactly as on macOS.
4. **Windows cage, opt-in (step 4).** Settings: "Enable the Windows network
   cage (one administrator prompt)". Setup runs the helper's install; runtime
   drives `srt-win exec` from `wrapSpawnForSandbox` with LAX's proxy in the
   permit range. A boot probe must show a direct external connect and a
   non-permitted loopback connect both fail and the proxy connect succeeds
   before `getSandboxStatus()` reports `confined: true`. Until then the
   truthful fallback stays. The helper is built and signed from source for the
   installer; the npm binary is for the spike only.
5. **Windows escape matrix, then the default-on decision** (owner's call).

## What needs the owner

- Step 4's helper spike on this workstation needs `srt windows-install`
  (one UAC prompt; it creates a local user and machine-wide WFP filters, both
  removable with `windows-uninstall`). Not run without an explicit yes.
- ~~The loopback policy for caged Windows spawns.~~ Decided 2026-09-28: loopback
  is OPEN inside the fence on Windows (the permit covers every loopback port;
  the proxy is protected by its token). Not yet delivered:
  the upstream helper's install refuses a permit wider than 50 ports
  (measured on 0.0.1), so the installed fence permits only the proxy's range
  and Windows behaves like Linux (loopback through the proxy, no NO_PROXY)
  until LAX builds the helper from source with the wide permit. The fence's job is
  off-machine egress; closing loopback breaks every non-HTTP dev tool, and a
  narrower permit still could not be scoped to the caged shell. Linux is
  closed by its mechanism (a namespace's loopback is its own): host services
  are reachable through the proxy, and registered local services directly
  through the in-cage forwarder (delivered 2026-09-28). macOS (2026-09-30)
  admits the same registered set in the seatbelt profile, like Linux: the
  kernel honors a port-specific allow for every port but a port-specific
  deny for only a few (measured on Darwin 25), so an open loopback with the
  debugging port carved out was never enforceable there. The one loopback
  egress channel LAX creates itself, the agent browser's debugging port, is
  withheld from the admitted set at its source (`security-config.ts`
  `reservedLoopbackPorts`), so no cage, proxy or `http_request` admits it.

## Step 5 — Windows escape matrix (2026-09-29, as the sandbox account; re-run in CI on every push by `scripts/win-cage/escape-matrix.ps1`)

| Probe | Result | Verdict |
|---|---|---|
| Direct HTTP to a loopback port outside the permit | "Unable to connect" | held |
| BITS transfer, off-box and to that port | "the user has not logged on to the network" | held (the sandbox logon carries no network credential) |
| ShellExecute on a URL (Start-Process) | "Access is denied" | held |
| COM Shell.Application.Open(url) | hangs; nothing reaches the port | held |
| SMB loopback (IPC share) | not reachable | held (SeDenyNetworkLogonRight) |
| schtasks /create then /run as the sandbox account | registers; never runs ("has not run", marker absent) | inert by design: the helper stamps SeDenyBatchLogonRight at install, so a task is persistence-spam with no logon to run under |
| DNS through the resolver service (Resolve-DnsName, .NET GetHostAddresses) | resolves, real answers | **residual**: the DNS client service answers for any user and the fence cannot attribute its queries; a DNS tunnel exfiltrates. Direct UDP/53 from the process is fenced (nslookup times out). |

Decision (2026-09-29): default-on, shipped as follows.

1. **The helper is ours.** `packages/srt-win` vendors the upstream Rust source
   (pinned commit in its README) with four constants changed so a machine that
   also runs Anthropic's runtime keeps both installs apart: account
   `lax-sandbox`, registry root `HKLM\SOFTWARE\Local Agent X\shell-cage`,
   state dir `%ProgramData%\Local Agent X\shell-cage`, its own sublayer GUID.
   The C runtime is linked statically (upstream issue 451). CI builds it on
   windows-latest, signs it with the installer's Azure Artifact Signing
   profile, verifies the publisher, embeds it in the standalone installer and
   attaches it to the release.
2. **One provisioning path.** `scripts/win-cage/provision.ps1` elevates itself
   once, checks the helper carries the installer's own publisher signature,
   copies it to `%ProgramData%\Local Agent Xin` and runs its install.
   The installer's `netcage` step, the app's Settings action and the
   uninstaller (`-Uninstall`) all run this one script.
3. **Proof on every push.** The `windows-cage` job in security.yml builds the
   helper, provisions the cage on the elevated runner, runs the matrix as the
   sandbox account and asserts the table above, then removes the cage.
4. **DNS stays a documented residual on Windows.** The shell policy refuses
   Resolve-DnsName, dig and nslookup by command; the proxy resolves for every
   proxy-aware client. The same channel on macOS is closed: the guarded
   seatbelt no longer allows the resolver socket, so names resolve only at the
   proxy (curl exits 6 inside the cage, and reaches the network through the
   proxy). Reported to Anthropic's vulnerability disclosure program for the
   Windows helper, since their design shares it.

Closed 2026-09-30: Electron's opt-in in-app debugging port
(`browserNativeDriving`) is reserved out of every loopback admission
(`security-config.ts reservedLoopbackPorts`): the macOS profile never allows
it, the Linux forwarder never listens on it, and the proxy and `http_request`
never judge it reachable. Windows' wide permit, when delivered, must derive
from the same union.

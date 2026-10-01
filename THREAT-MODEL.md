# Threat Model — Local Agent X

This is the design-internal threat model. For vulnerability reporting procedure, SLAs, and the secure deployment checklist, see [SECURITY.md](SECURITY.md).

## Trust Model

Local Agent X operates as a **single-user personal AI agent** on a local workstation. The system is NOT designed for multi-tenant or adversarial multi-user deployments.

Key properties:
- The HTTP server binds to `127.0.0.1` only (not exposed to network).
- Authentication is a shared bearer token (single-user).
- Tools execute with the host user's privileges.

### Trust Domains

| Domain | Trust Level | Examples |
|--------|-------------|---------|
| **System policy** | Highest | System prompt, tool definitions, security rules |
| **User instructions** | High | Chat messages typed by the authenticated user |
| **Agent memory** | Medium-High | Persisted facts, profile files (can be tainted) |
| **Tool results** | Low | File contents, shell output, API responses |
| **External content** | Untrusted | Web pages, API responses, browser-extracted text |

**Key principle**: Untrusted content must NEVER flow into higher trust domains without sanitization and review.

## Threat Actors

### 1. External Attacker (via prompt injection)
- **Capability**: Can craft malicious web content the user asks the agent to process
- **Goal**: Exfiltrate secrets, execute commands, persist backdoor instructions
- **Mitigations**: Content wrapping, canary tokens, exfiltration detection, memory taint protection

### 2. Local Attacker (user-level foothold)
- **Capability**: Read access to `~/.lax/`, can observe process, may have network position
- **Goal**: Steal credentials, hijack agent, impersonate user
- **Mitigations**: Encrypted secrets (AES-256-GCM + per-install salt), file permissions (0600), token hashing

### 3. Compromised LLM (model manipulation)
- **Capability**: The model itself generating harmful tool calls
- **Goal**: Data exfiltration, destructive operations, credential theft
- **Mitigations**: Default-deny tool policy, shell exfil blocking, threat scoring, loop detection, RBAC

### 4. Supply Chain Attacker
- **Capability**: Compromise npm dependencies
- **Goal**: Code execution in the agent process
- **Mitigations**: Lockfile enforcement, minimal dependencies, no plugin marketplace (yet)

## Attack Surfaces

### 1. Network Surface
- **Exposed**: HTTP server on `127.0.0.1:7007` (loopback only)
- **Risk**: Low for remote attacks. Cross-origin attacks mitigated by CORS loopback-only + CSRF guard.
- **Residual risk**: Local malware can reach loopback.

### 2. Tool Execution Surface
- **Shell**: Metacharacter rejection, blocked commands, network-client policy, env sanitization, guarded native cage by default where supported, optional strict native or Docker confinement
- **File**: Path normalization, symlink detection, sensitive path blocking, core file protection
- **HTTP**: SSRF protection, DNS pinning, redirect header stripping, content wrapping
- **Browser**: DNS pinning, evaluate sandbox, session isolation, snapshot sanitization

### 3. Memory/Persistence Surface
- **Risk**: Untrusted content persisted as trusted context → durable prompt injection
- **Mitigations**: Memory taint checking (blocks external markers + injection patterns), autoExtract taint filter

### 4. Authentication Surface
- **Risk**: Bearer token theft → full agent control
- **Mitigations**: RBAC with scoped roles, token stripped from URL immediately, sessionStorage over localStorage, timing-safe comparison

### MITRE ATLAS Mapping

| Technique | ID | Our Defense |
|---|---|---|
| LLM Prompt Injection | AML.T0051 | sanitize.ts (41 patterns), content wrapping, canary tokens |
| LLM Jailbreak | AML.T0054 | Session policies, ARI Kernel behavioral rules |
| Adversarial Input | AML.T0048 | Homoglyph normalization, control char stripping |
| Exfiltration via ML Model | AML.T0024 | Data lineage tracking, egress allowlist, encoding detection |
| Model Supply Chain | AML.T0010 | Lockfile, minimal deps, npm audit |
| Denial of Service | AML.T0029 | Rate limiting, loop detection, circuit breaker |

## Defense Layers

Single canonical numbering. This is the source of truth — no parallel numbering elsewhere.

```
Layer -1: ARI Kernel         — Capability tokens, taint propagation, behavioral rules, quarantine
Layer 0:  Session Policy     — Per-session modes (default / high-security / dev-mode / read-only)
Layer 1:  SecurityLayer      — SSRF with DNS pinning (anti-rebinding), shell metacharacter rejection + blocked-command list, network-client blocking, path normalization + symlink detection, obfuscation, egress allowlist
Layer 2:  Data Lineage       — Tracks sensitive reads → blocks egress when tainted
Layer 3:  RBAC               — Role-based tool permissions enforced at execution time
Layer 4:  ToolPolicy         — Configurable allow/deny (default-deny), per-tool rate limits, host allowlists/denylists, configured via `~/.lax/tool-policy.json`
Layer 5:  ThreatEngine       — Canary tokens, chain analysis (exfil patterns: read-sensitive → send-external), loop detection (generic repeat, ping-pong, circuit breaker), data classification (auto-tags credentials / PII / secrets / financial), encoding detection, adaptive scoring
Layer 6:  Content Sanitizer  — 41 injection patterns, Unicode homoglyph normalization, external-content wrapping with unique boundary markers
Layer 7:  Memory Taint       — Blocks untrusted content from persisting to memory
Layer 8:  Shell/Server Sandbox — Guarded by default: macOS `seatbelt` or Linux `bwrap` denies credential paths and lets the shell off the machine only through the loopback egress proxy (macOS: loopback direct, off-machine denied at the kernel; Linux: an empty network namespace whose one way out is the proxy's bind-mounted socket). Stricter native modes deny all network with no proxy route; Docker provides hermetic isolation. Unsupported guarded backends visibly fall back to host and unattended shell paths require explicit acknowledgement. Whole-server confinement is available via boot re-exec on macOS/Linux. Windows runs guarded shells as a dedicated local account fenced by Windows Filtering Platform, provisioned by the installer with one administrator prompt (or later from Settings) and used only once its fence is proven at first use; until then guarded falls back visibly to host. Its one known gap is name lookups through the Windows DNS service (see "Windows shell confinement" below)
Layer 9:  Crypto Audit Trail — Tamper-evident SHA-256 hash chain + ARI Kernel audit DB, per-session threat scoring, daily JSONL files at `~/.lax/audit/`
Layer 10: Output Redaction   — Credential masking before AI sees tool results
```

## Known Limitations

1. **Single-user model** — RBAC adds roles (operator / user / readonly) but not full enterprise IAM (OIDC/SAML planned). Don't share a single instance between mutually untrusted users.
2. **Shell sandbox coverage is platform-dependent** — The selected default is `guarded`; macOS and Linux apply a credential-denying native cage whose only route off the machine is the egress proxy (see Layer 8). Stricter `seatbelt`/`bwrap` modes deny network outright, and Docker mode works across platforms. **Windows** runs the shell as a separate account behind a firewall fence; name lookups through the Windows DNS service are not fenced (see "Windows shell confinement"). An unavailable selected backend produces a visible effective-`host` fallback; unattended delegated/API shell paths remain blocked until the user acknowledges that posture. **The Linux cage has never been exercised on a live machine.** No maintainer runs Local Agent X on Linux day to day; the bubblewrap namespace, the unix-socket bridge and the guarded egress contract are verified only by the CI lane (ubuntu-latest with bubblewrap installed). macOS and Windows are verified on real machines (on Windows, with the cage installed from Settings; the installer's provisioning step has not yet run on a fresh machine). Treat Linux as CI-proven, not field-proven, and report what you see.
3. **Secrets and LAX-owned provider auth encryption** — AES-256-GCM data is protected by a master key in DPAPI, macOS Keychain, or Linux libsecret when available; the weaker fallback derives the key from machine identity plus a local scrypt salt. CLI-native stores are outside this boundary; see [docs/provider-auth.md](docs/provider-auth.md).
4. **Memory taint is heuristic** — Pattern-based detection + Unicode normalization can be evaded by sufficiently creative injection. ARI Kernel taint tracking adds formal enforcement.
5. **No formal verification** — Security properties are tested empirically, not formally proven.
6. **Web access has two modes** — A fresh install is `permissive`: any public host is reachable, with the SSRF / private-IP / cloud-metadata blocks applied and the outbound checks (registered-secret scan and the data-flow evidence check on what the agent read) deciding what may leave. `strict` reaches only allowlisted sites (wildcards like `*.example.com` supported); a missing or non-array allowlist denies every site, an explicit empty `[]` is honored as "deny everything", and a refusal names the host so the user can allow it from the chat's block notice or Settings → Security → Web access. The same policy applies to web_fetch, http_request, the browser tool, the caged shell's egress proxy, and the search and image-acquisition tools through the hardened fetch. **Private content under `permissive`:** an email body the agent read, or a document from the user's own folders (Documents, Desktop, Downloads, OneDrive; the agent's workspace excluded), is fingerprinted when read. A send that carries its bytes (email, calendar invite, http_request, web_fetch, a browser navigation URL, or text typed into a page) to a destination the user did not choose asks the user first, naming the source and the destination; an unattended run is refused instead. A destination counts as chosen when it is the user's own address, on the trusted-destinations list, written by the user in the chat, or, for content from one opened email, someone already on that email. **Known limits:** pages the agent reads in the user's logged-in browser are not tracked as private; recipients of a search or inbox listing are not treated as chosen, so replying with quoted text from a listing asks; and content the model rewords beyond the 24-character evidence window is not matched. `strict` closes the remaining path at the cost of approving sites.

## Windows shell confinement

On macOS and Linux, the default `guarded` profile uses seatbelt/bwrap to shadow
credential paths and route external network through the egress proxy while
keeping common development paths.
The explicit strict `seatbelt`/`bwrap` modes additionally deny external network
and more configuration paths.

On Windows, `guarded` runs the shell as a dedicated local account,
`lax-sandbox`, fenced by Windows Filtering Platform. The installer provisions it
with one administrator prompt; a declined prompt or a developer install can
provision it later from Settings → Security, and the uninstaller removes it. The
helper that provisions it is built from source (vendored from Anthropic's
sandbox-runtime, `packages/srt-win`) and signed by the installer's publisher.
The app uses the cage only after proving the fence at first use. Until then, or
when provisioning failed, guarded falls back visibly to unconfined host and
unattended shell paths require explicit acknowledgement; the in-process guards
(shell-policy denylist, path/symlink guard, egress/lineage layers) still apply
there, but they are best-effort, not a kernel boundary.

The escape matrix (`scripts/win-cage/escape-matrix.ps1`) runs as the sandbox
account on an elevated CI runner on every push and asserts:

- a direct connection to anything but the egress proxy's loopback ports is refused;
- BITS, a URL handed to another app (ShellExecute) and SMB do not get out;
- a scheduled task can be registered but never runs (the account has no batch
  logon right).

The account cannot read the user's profile (`~/.ssh`, `~/.lax`); the app grants
it read access to the shell and runtime it ships and write access to the
workspace.

**Known gap: name lookups.** Windows programs resolve names through the shared
DNS Client service, which sends the query under its own account, so the fence
cannot tell a lookup made for the sandbox account from anyone else's. A caged
shell can therefore carry data out inside the names it looks up, a few dozen
characters per query, to a DNS server an attacker runs. What it can put there is
limited to what it can read (the workspace, not the profile) and what the agent
writes into a command. The shell policy refuses the lookup commands
(Resolve-DnsName, nslookup, dig, host, ping), but a script can reach the service
by other means. Tools that use the proxy (curl, git, npm, pip, Node with the
injected proxy settings) hand names to the proxy and do not need the service, so
nothing the cage supports depends on it. Windows offers no per-account switch
for the service: RPC filters apply only to calls from other machines, and the
service refuses only AppContainer callers without a network capability, a mode
that cannot run the toolchain (below). The macOS and Linux cages do not have
this gap. The escape matrix asserts the lookup as still resolving, so the day it
is closed the assertion is flipped on purpose.

### Why not AppContainer (evaluated, rejected)

A native arm was prototyped against **AppContainer** (the userspace analog to
seatbelt/bwrap: per-process, kernel-enforced, no admin). The **cage itself holds** —
a no-capability AppContainer empirically denied external network (socket blocked),
denied a planted secret in `~/.ssh`, denied user-profile enumeration, and allowed
writes only to explicitly granted dirs. But it fails the **usability contract** that
makes seatbelt/bwrap shippable, on two independent counts:

1. **Native dev tools won't execute inside the container.** Files in granted dirs
   are fully readable (probed: `node.exe` stat + full 87 MB read succeed), but
   *launching* the toolchain fails across every entry path tried — PowerShell's
   call operator (`& exe` → FileSystem-provider error in the locked token), .NET
   `Process.Start` (hangs), and a `cmd.exe` batch (exits without running). A shell
   that can't spawn `node`/`git`/`npm` is not a usable dev shell.
2. **Inverted posture.** AppContainer is *default-deny over the entire user
   profile*, the opposite of the seatbelt/bwrap "bind the host, shadow the few
   sensitive dirs" model. Because the LAX repo and common toolchains (nvm's node,
   user-installed CLIs) live under the profile, every one would need an open-ended,
   per-path grant that changes per command — effectively docker's hermetic posture
   without docker's clean isolation.

The shipped design is the restricted-local-user alternative: a separate account
behind a firewall fence. Its costs were an administrator prompt at install and
read grants for the toolchain the app ships, since a second account cannot read
the main user's profile. Revisit AppContainer if Windows ships a bind-mount-style
namespace primitive (targeted-deny over a bound host); it would also close the
lookup gap above.

## Incident Response

1. **If canary trips**: Agent response is killed immediately. Check audit logs for the session.
2. **If threat score hits critical**: External tools auto-blocked. Review recent tool calls.
3. **If exfiltration detected**: Tool call blocked. Review chain analysis for source and sink.
4. **If token compromised**: Revoke via RBAC, rotate auth token in `~/.lax/config.json`.
5. **If memory poisoned**: Review `~/.lax/memory/` files. Check audit trail for suspicious `memory_save` calls.

## Compliance Notes

- All security decisions are logged in tamper-evident audit trail (`~/.lax/audit/`)
- Audit chain integrity can be verified via `GET /api/audit/verify`
- Credential redaction is applied to tool output before it reaches the LLM or UI
- File permissions are set to `0600` on all sensitive files

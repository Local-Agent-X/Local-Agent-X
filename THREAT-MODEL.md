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
- **Shell**: Metacharacter rejection, blocked commands, network client blocking, env sanitization, optional Docker sandbox
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
| LLM Prompt Injection | AML.T0051 | sanitize.ts (35 patterns), content wrapping, canary tokens |
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
Layer 6:  Content Sanitizer  — 36 injection patterns, Unicode homoglyph normalization, external-content wrapping with unique boundary markers
Layer 7:  Memory Taint       — Blocks untrusted content from persisting to memory
Layer 8:  Shell/Server Sandbox — Guarded by default: macOS `seatbelt` or Linux `bwrap` denies credential paths while retaining network access. Stricter native modes also deny external network; Docker provides hermetic isolation. Unsupported guarded backends visibly fall back to host and unattended shell paths require explicit acknowledgement. Whole-server confinement is available via boot re-exec on macOS/Linux. Windows has no native equivalent — Docker is the confinement answer there (see "Windows shell confinement" below)
Layer 9:  Crypto Audit Trail — Tamper-evident SHA-256 hash chain + ARI Kernel audit DB, per-session threat scoring, daily JSONL files at `~/.lax/audit/`
Layer 10: Output Redaction   — Credential masking before AI sees tool results
```

## Known Limitations

1. **Single-user model** — RBAC adds roles (operator / user / readonly) but not full enterprise IAM (OIDC/SAML planned). Don't share a single instance between mutually untrusted users.
2. **Shell sandbox coverage is platform-dependent** — The selected default is `guarded`; macOS and Linux apply a credential-denying native cage while keeping network access. Stricter `seatbelt`/`bwrap` modes deny network, and Docker mode works across platforms. **Windows has no native mode — use Docker** (see "Windows shell confinement"). An unavailable selected backend produces a visible effective-`host` fallback; unattended delegated/API shell paths remain blocked until the user acknowledges that posture.
3. **Secrets and LAX-owned provider auth encryption** — AES-256-GCM data is protected by a master key in DPAPI, macOS Keychain, or Linux libsecret when available; the weaker fallback derives the key from machine identity plus a local scrypt salt. CLI-native stores are outside this boundary; see [docs/provider-auth.md](docs/provider-auth.md).
4. **Memory taint is heuristic** — Pattern-based detection + Unicode normalization can be evaded by sufficiently creative injection. ARI Kernel taint tracking adds formal enforcement.
5. **No formal verification** — Security properties are tested empirically, not formally proven.
6. **Egress allowlist has two modes** — Default is `permissive`: all public hosts are reachable (SSRF / private-IP / cloud-metadata blocks still apply), and `~/.lax/egress-allowlist.json` gates only secret-bearing request bodies at the tool layer. Opt into `strict` mode via `~/.lax/security.json` (`egressMode: "strict"`) for true deny-by-default egress, where only allowlisted domains pass (wildcards like `*.example.com` supported) and a missing or non-array file denies all egress with a setup hint. Explicit empty `[]` is honored as "deny everything."

## Windows shell confinement

The agent shell runs under OS-native kernel confinement on macOS (`seatbelt`) and
Linux (`bwrap`): a targeted-deny posture that blocks external network and shadows
the sensitive home dirs/persistence vectors while leaving the dev shell usable
(`npm install`, `git`, workspace I/O all work). **Windows has no equivalent native
mode** — there, `LAX_SANDBOX` exposes only `host` and `docker`, and **Docker is the
documented Windows confinement answer.** The in-process guards (shell-policy
denylist, path/symlink guard, egress/lineage layers) still apply on Windows in
host mode, but they are best-effort, not a kernel boundary.

### Why not a native Windows mode (AppContainer evaluated, rejected)

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

The restricted-local-user alternative (separate `lax-shell` account + `icacls`
denies + firewall `-LocalUser` block) was not pursued: it requires admin, hits the
same wall (a second principal cannot read the main user's workspace/toolchain), and
adds spawn-as-user credential plumbing. Per the project's security stance, an honest
"no native mode, use Docker" beats shipping a confinement wrapper whose self-check
had to be weakened to pass. Revisit if Windows ships a bind-mount-style namespace
primitive (targeted-deny over a bound host), which is the piece AppContainer lacks.

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

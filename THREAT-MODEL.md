# Threat Model — Open Agent X

## Trust Model

Open Agent X operates as a **single-user personal AI agent** on a local workstation. The system is NOT designed for multi-tenant or adversarial multi-user deployments.

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
- **Capability**: Read access to `~/.sax/`, can observe process, may have network position
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
- **Exposed**: HTTP server on `127.0.0.1:4800` (loopback only)
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

## Defense Layers

```
Layer 1: SecurityLayer      — Static rules (SSRF, shell, file, path traversal)
Layer 2: ToolPolicy          — Configurable allow/deny (default-deny)
Layer 3: ThreatEngine        — Behavioral analysis (chains, canaries, scoring)
Layer 4: Content Sanitizer   — Prompt injection defense (wrapping, homoglyphs)
Layer 5: Memory Taint        — Persistence protection (blocks untrusted → memory)
Layer 6: RBAC                — Role-based access control (operator/user/readonly)
Layer 7: Container Sandbox   — Optional Docker isolation (SAX_SANDBOX=docker)
Layer 8: Crypto Audit Trail  — Tamper-evident logging (SHA-256 hash chains)
— Future —
Layer 9: ARI Kernel          — Capability-based enforcement, taint tracking, policy engine
```

## Known Limitations

1. **No container sandbox by default** — Tools run on host. Set `SAX_SANDBOX=docker` for isolation.
2. **Single-user model** — RBAC adds roles but not true multi-tenancy. Don't share a single instance between mutually untrusted users.
3. **Secrets bound to machine** — Key derivation uses hostname + username + random salt. Not OS keychain. If attacker has file read + knows machine identity, they can attempt offline cracking (scrypt N=32768 provides ~100ms per attempt).
4. **Memory taint is heuristic** — Pattern-based detection can be evaded by sufficiently creative injection. Defense-in-depth (canaries, scoring, wrapping) reduces but doesn't eliminate risk.
5. **No formal verification** — Security properties are tested empirically, not formally proven.

## Incident Response

1. **If canary trips**: Agent response is killed immediately. Check audit logs for the session.
2. **If threat score hits critical**: External tools auto-blocked. Review recent tool calls.
3. **If exfiltration detected**: Tool call blocked. Review chain analysis for source and sink.
4. **If token compromised**: Revoke via RBAC, rotate auth token in `~/.sax/config.json`.
5. **If memory poisoned**: Review `~/.sax/memory/` files. Check audit trail for suspicious `memory_save` calls.

## Compliance Notes

- All security decisions are logged in tamper-evident audit trail (`~/.sax/audit/`)
- Audit chain integrity can be verified via `GET /api/audit/verify`
- Credential redaction is applied to tool output before it reaches the LLM or UI
- File permissions are set to `0600` on all sensitive files

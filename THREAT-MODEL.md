# Threat Model — Local Agent X

## Trust Model

Local Agent X operates as a **single-user personal AI agent** on a local workstation. The system is NOT designed for multi-tenant or adversarial multi-user deployments.

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
| LLM Prompt Injection | AML.T0051 | sanitize.ts (54+ patterns), content wrapping, canary tokens |
| LLM Jailbreak | AML.T0054 | Session policies, ARI Kernel behavioral rules |
| Adversarial Input | AML.T0048 | Homoglyph normalization, control char stripping |
| Exfiltration via ML Model | AML.T0024 | Data lineage tracking, egress allowlist, encoding detection |
| Model Supply Chain | AML.T0010 | Lockfile, minimal deps, npm audit |
| Denial of Service | AML.T0029 | Rate limiting, loop detection, circuit breaker |

## Defense Layers

```
Layer -1: ARI Kernel         — Capability tokens, taint propagation, behavioral rules, quarantine
Layer 0:  Session Policy     — Per-session modes (default/high-security/dev-mode/read-only)
Layer 1:  SecurityLayer      — SSRF, shell injection, path traversal, obfuscation, egress allowlist
Layer 2:  Data Lineage       — Tracks sensitive reads → blocks egress when tainted
Layer 3:  RBAC               — Role-based tool permissions enforced at execution time
Layer 4:  ToolPolicy         — Configurable allow/deny (default-deny)
Layer 5:  ThreatEngine       — Canary tokens, chain analysis, encoding detection, adaptive scoring
Layer 6:  Content Sanitizer  — 54+ injection patterns, homoglyphs, external content wrapping
Layer 7:  Memory Taint       — Blocks untrusted content from persisting to memory
Layer 8:  Container Sandbox  — Docker auto-detected (SAX_SANDBOX=host to disable)
Layer 9:  Crypto Audit Trail — Tamper-evident SHA-256 hash chain + ARI Kernel audit DB
Layer 10: Output Redaction   — Credential masking before AI sees tool results
```

## Known Limitations

1. **Single-user model** — RBAC adds roles but not true multi-tenancy. Don't share a single instance between mutually untrusted users.
2. **Docker sandbox auto-detects** — If Docker is available, bash runs in containers by default. Set `SAX_SANDBOX=host` to disable.
3. **Secrets encryption** — Uses OS keychain (DPAPI/Keychain) when available, falls back to scrypt N=131072 (~500ms/attempt).
4. **Memory taint is heuristic** — Pattern-based detection + Unicode normalization can be evaded by sufficiently creative injection. ARI Kernel taint tracking adds formal enforcement.
5. **No formal verification** — Security properties are tested empirically, not formally proven.
6. **Egress allowlist is opt-in** — Create `~/.sax/egress-allowlist.json` to restrict outbound domains. Without it, all public domains are allowed.

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

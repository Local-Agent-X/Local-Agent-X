# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Open Agent X, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. Email: [TBD - add security contact email]
2. GitHub: Use [GitHub Security Advisories](https://github.com/petermanrique101-sys/Open-Agent-X/security/advisories/new) to privately report vulnerabilities.

### What to Include

- Description of the vulnerability
- Steps to reproduce (proof of concept if possible)
- Impact assessment (what can an attacker do?)
- Affected versions/components
- Suggested fix (if you have one)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Triage**: Within 7 days
- **Fix**: Critical issues within 14 days; others within 30 days
- **Disclosure**: Coordinated disclosure after fix is released

## Security Architecture

Open Agent X uses a multi-layered security model:

### Layer 1: SecurityLayer (Static Rules)
- SSRF protection with DNS pinning (prevents DNS rebinding)
- Shell command validation (metacharacter rejection + blocked patterns)
- File access control (symlink detection + path normalization)
- Network exfiltration prevention (shell network clients blocked)
- Credential redaction in tool output

### Layer 2: Tool Policy (Configurable)
- Default-deny policy: only explicitly allowed tools can execute
- Per-tool rate limits
- Host allowlists/denylists
- Configurable via `~/.sax/tool-policy.json`

### Layer 3: Threat Engine (Behavioral)
- Tool chain analysis: detects exfiltration patterns (read sensitive → send external)
- Loop detection: generic repeat, ping-pong, circuit breaker
- Canary tokens: detects prompt injection by monitoring for leaked system prompt content
- Data classification: auto-tags tool results (credentials, PII, secrets, financial)
- Adaptive threat scoring: restricts external tools when session risk is high

### Layer 4: Content Sanitization
- External content wrapping with unique boundary markers
- Prompt injection pattern detection with scoring
- Unicode homoglyph normalization
- Memory taint protection: blocks untrusted content from persisting to memory files

### Layer 5: Cryptographic Audit Trail
- Hash-chained audit logs (SHA-256, tamper-evident)
- Per-session threat scoring and decision tracking
- Daily JSONL files at `~/.sax/audit/`

## Trust Model

Open Agent X is designed as a **single-user personal agent** running on a local workstation. Key assumptions:

- The server binds to `127.0.0.1` only (not exposed to network)
- Authentication is via a shared bearer token (single-user model)
- Tools execute with the host user's privileges
- The system is NOT designed for multi-user or multi-tenant deployment

### Known Limitations

- No container/VM sandboxing for tool execution (tools run on host)
- No enterprise IAM (OIDC/SAML/RBAC) — single shared token
- Secrets encryption is machine-identity bound (not OS keychain)
- Memory/profile files are trusted context — poisoning is mitigated but not impossible

## Secure Deployment Checklist

- [ ] Run on a dedicated user account with minimal privileges
- [ ] Enable full-disk encryption on the host
- [ ] Keep `~/.sax/` directory permissions at `0700`
- [ ] Review `~/.sax/tool-policy.json` for your use case
- [ ] Monitor `~/.sax/audit/` logs for anomalies
- [ ] Do NOT expose port 4800 to the network
- [ ] Do NOT share the bearer token across users
- [ ] Regularly rotate the auth token (delete `~/.sax/config.json` authToken field)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

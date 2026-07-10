# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Local Agent X, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

Use [GitHub Security Advisories](https://github.com/Local-Agent-X/Local-Agent-X/security/advisories/new) to privately report vulnerabilities.

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

## Threat Model

Local Agent X is a single-user personal agent designed for a local workstation. For the full trust model, threat actors, attack surfaces, defense-layer architecture, and incident response, see [THREAT-MODEL.md](THREAT-MODEL.md).

## Secure Deployment Checklist

- [ ] Run on a dedicated user account with minimal privileges
- [ ] Enable full-disk encryption on the host
- [ ] Keep `~/.lax/` directory permissions at `0700`
- [ ] Verify the effective shell sandbox in Settings → Security. The selected default is `guarded`: macOS/Linux use a kernel cage that denies credential paths while retaining normal network access. If that backend is unavailable (including Windows), LAX reports an effective `host` fallback and requires explicit acknowledgement before unattended shell paths run. Select stricter `LAX_SANDBOX=seatbelt`, `bwrap`, or `docker` where appropriate. Optionally confine the whole server with `LAX_SERVER_SANDBOX=1`.
- [ ] Create `~/.lax/egress-allowlist.json` with approved domains — a JSON array, e.g. `["api.anthropic.com", "*.example.com"]`
- [ ] Review `~/.lax/tool-policy.json` for your use case
- [ ] Monitor `~/.lax/audit/` logs for anomalies
- [ ] Export logs to SIEM via `GET /api/logs/export` (NDJSON format)
- [ ] Do NOT expose port 7007 to the network
- [ ] Do NOT share the bearer token across users
- [ ] Rotate auth token periodically via `POST /api/auth/rotate`

## Data Retention

- Chat sessions: stored in `~/.lax/sessions/` as JSONL (can be deleted per-session)
- Audit logs: stored in `~/.lax/audit/` as JSONL (append-only, hash-chained)
- Memory: stored in `~/.lax/memory/` as Markdown (synced if Agent Sync enabled)
- Uploads: stored in `~/.lax/uploads/` (can be cleaned manually)
- Secrets: encrypted at rest in `~/.lax/secrets.enc` (AES-256-GCM)
- LAX-owned OpenAI, Anthropic setup-token, and xAI OAuth credentials: AES-256-GCM envelopes in historically named `*.json` files; CLI-native credential stores are outside this guarantee. See [docs/provider-auth.md](docs/provider-auth.md).
- No data is sent to external services except the configured LLM provider (e.g. Anthropic, OpenAI, xAI, Google Gemini, Cerebras, or a custom endpoint; local/Ollama models run on-device)
- PI (Personal Information) in chat is not automatically redacted from storage — use high-security session mode for sensitive conversations

## Security Advisory Process

We use GitHub Security Advisories for responsible disclosure. Published advisories include:
- CVE ID (when applicable)
- Affected versions
- Impact assessment
- Remediation steps
- Timeline

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes (current) |
| < 0.5   | Security fixes only |

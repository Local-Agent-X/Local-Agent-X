# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Local Agent X, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. Email: petermanrique101@gmail.com
2. GitHub: Use [GitHub Security Advisories](https://github.com/Local-Agent-X/Local-Agent-X/security/advisories/new) to privately report vulnerabilities.

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
- [ ] Keep `~/.sax/` directory permissions at `0700`
- [ ] Enable Docker sandbox (`SAX_SANDBOX=docker` or auto-detect)
- [ ] Create `~/.sax/egress-allowlist.json` with approved domains
- [ ] Review `~/.sax/tool-policy.json` for your use case
- [ ] Enable HTTPS in settings for encrypted localhost traffic
- [ ] Monitor `~/.sax/audit/` logs for anomalies
- [ ] Export logs to SIEM via `GET /api/logs/export` (NDJSON format)
- [ ] Do NOT expose port 7007 to the network
- [ ] Do NOT share the bearer token across users
- [ ] Rotate auth token periodically via `POST /api/auth/rotate`

## Data Retention

- Chat sessions: stored in `~/.sax/sessions/` as JSON (can be deleted per-session)
- Audit logs: stored in `~/.sax/audit/` as JSONL (append-only, hash-chained)
- Memory: stored in `~/.sax/memory/` as Markdown (synced if Agent Sync enabled)
- Uploads: stored in `~/.sax/uploads/` (can be cleaned manually)
- Secrets: encrypted at rest in `~/.sax/secrets.enc` (AES-256-GCM)
- No data is sent to external services except the configured LLM API (OpenAI/xAI)
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
| 0.2.x   | Yes (current) |
| 0.1.x   | Security fixes only |

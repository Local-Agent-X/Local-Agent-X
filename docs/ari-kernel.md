# ARI Kernel — what it is, what it does, what it's for

The ARI Kernel is Local Agent X's in-process security layer. **Every tool call routes
through it** before it touches your disk, your accounts, or the network. It is the
deepest defense layer (Layer -1 in [THREAT-MODEL.md](../THREAT-MODEL.md)).

It ships vendored in [`packages/arikernel/`](../packages/arikernel/) (core / runtime /
taint-tracker / policy-engine / audit-log / tool-executors) and is wired into the
runtime by [`src/ari-kernel/`](../src/ari-kernel/). No tool execution path bypasses it
— a new tool is default-deny until it has an explicit classification + allow rule
([`src/tool-policy/tool-policies.data.ts`](../src/tool-policy/tool-policies.data.ts)).

## What it does

- **Per-tool policy + RBAC, default-deny.** Each call is evaluated against the active
  preset's policy rules and the caller's role. Unknown/unclassified tools fail closed.
- **Capability grants.** The host principal is granted a fixed manifest of tool-class
  capabilities at boot; the per-call rule engine still runs on top of every grant.
- **Data-lineage taint tracking.** Reading a sensitive source (a secret-shaped value, a
  sensitive file path) taints the session; taint is sticky and flows to sub-agents.
  Tainted egress is then blocked even through transforms (base64/hex/chunked).
- **Egress guards on every off-box sink** (`http_request`, `email_send`,
  `clipboard_write`, `browser`, `process_start`, …):
  - outbound **secret-scan** — blocks credential/secret-shaped payloads (allowlist-aware
    for http);
  - **data-lineage floor** — a tainted session can't egress;
  - **canary tripwire** — a planted token in an outbound payload is definitive context
    exfiltration → hard block + audit;
  - **opt-in financial/SSN DLP** (default off) — see Configuration.
- **Content sanitizer.** Untrusted content from external channels — `web_fetch`,
  `http_request`, `browser` (extract/snapshot/navigate), **MCP** server output, and
  **SQL** query output — is run through `wrapExternalContent`: control-char stripping,
  homoglyph normalization, pseudo-system-tag stripping, known-secret redaction, boundary
  wrapping, and an injection-pattern **warning flag** — before the model sees it.
- **Memory protection.** Writes to memory are gated: secrets are redacted and durable
  prompt-injection is blocked (`writeMemorySafely`).
- **Tamper-evident audit trail.** Every decision is logged to a SHA-256/HMAC hash chain.

## What it's for — and what it is not

**ARI is exfiltration-containment defense-in-depth.** Its job starts *after* the model
has been tricked or compromised: contain the damage. On that job it is measured and
strong — **0 → 90% containment of a compromised agent's data exfiltration, 98% of
credentials, holding through base64/hex/gzip** (see
[benchmarks/ari-security.md](benchmarks/ari-security.md)).

**ARI is *not* a prompt-injection shield against action-hijack.** Against AgentDojo
(injected instructions trying to make the agent perform an unauthorized action) a
frontier model already resists ~99.9% on its own — that defense is the *model*, not ARI.
ARI's value rises exactly as the model's reliability falls: weaker / local / fine-tuned
/ jailbroken / future-more-capable / genuinely-malicious models. It is the seatbelt,
not the careful driver.

**Scope of the content sanitizer.** It wraps + flags *untrusted external* channels
(web / http / browser / MCP / SQL). It does **not** wrap owned-source reads (your own
files via `read`, `bash` output, email, memory) — those are treated as your data and get
secret-redaction + taint tracking instead, not the untrusted-content boundary wrapper.

**Known gaps (honest):**
- `chunked-half` — a secret split below detection length can slip the scanners (same
  limitation as the credential scanner).
- Email addresses / phone numbers are deliberately **not** gated by the DLP guard —
  `classifyData` lumps emails under `pii`, so gating them would block every legitimate
  `email_send` recipient. The guard covers financial accounts (IBAN/card) + SSN only.

## Configuration

- **Presets** select the policy rule set; the default session preset is
  `workspace-assistant`. It allows clean outbound writes (email/calendar/API) and denies
  http writes only when the session is tainted by web/rag/email content — so legitimate
  comms work while tainted egress is blocked. Other presets: `strict`, `safe`,
  `research`, `automation-agent`, etc. ([`policy-spec.json`](../packages/arikernel/core/src/presets/policy-spec.json)).
- **Opt-in financial/SSN egress DLP** (default **off**): set `dataEgressGuard: true` in
  `~/.lax/security.json`, or `LAX_DATA_EGRESS_GUARD=1`. When on, outbound payloads
  carrying financial-account data (IBAN/card) or an SSN are blocked to non-allowlisted
  hosts, across decoded views (base64/hex). Default-off so it never regresses normal use.
- **Egress allowlist:** `~/.lax/egress-allowlist.json` whitelists destinations that may
  legitimately receive secret/financial payloads.

## See also

- [benchmarks/ari-security.md](benchmarks/ari-security.md) — the benchmark results + reproduction.
- [THREAT-MODEL.md](../THREAT-MODEL.md) — full threat model, trust domains, defense layers, MITRE ATLAS mapping.
- [SECURITY.md](../SECURITY.md) — reporting + secure-deployment checklist.
- [packages/arikernel/AGENTS.md](../packages/arikernel/AGENTS.md) — internal dev guide (hands-off unless fixing a specific bug).

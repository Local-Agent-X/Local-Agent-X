# ADR 0004 — Split the secret scanner into a control tier and an advisory tier

Status: Proposed — 2026-09-07

## Context

Two attempts to fix the secret scanner's encoded-content peel were shipped and
reverted the same day (`f8c0ceb8`, `cbe4adc9`). Each closed a real hole and
opened a quieter one, and in both cases the new hole was silent: `clean=true`,
no flag raised, suite fully green. That pattern prompted the question this ADR
answers — is the design correct, or were we polishing a design that permits the
bug?

The initial thesis was "content scanning can never be proof, so demote the whole
scanner to advisory and move what we can onto capability confinement." An
audit of every consumer disproved most of it. What follows is what the code
actually shows.

### Capability confinement is already complete in the direction it covers

Every vault-to-sink path injects the credential server-side and never puts the
plaintext in the model's message array: `browser_fill_from_secret`
(`browser/secret-fill.ts:219`), `browser_capture_secret`
(`secret-capture.ts:158`), `http_request` `{{NAME}}` substitution inside
`execute` (`tools/http-request.ts:101`), MCP `${secret:NAME}` expansion
(`mcp-client/placeholders.ts:25`), the connector proxy
(`routes/connector-proxy.ts:285`), SMTP/IMAP by secret name
(`tools/email-config.ts:42`), `list_secrets` (names and metadata only), and
`request_secret` (vault to disk via a UI modal, never a tool result). Shell is
explicitly refused a vault channel (`security/layer/shell-detectors.ts:92` —
`{{SECRET}}` in a command "would leak the secret into argv").

There is nothing left to move. Confinement does not shrink the scanner's job,
because the scanner's job is the *other* direction: a credential arriving from
a file, a webpage, a database row, or the user's own keyboard.

### The scanner is not parallel to taint — it constructs it

`tool-execution/sensitive-read-taint.ts:283` creates `source:"secret"` taint
entries *only* from `detectSecretsInOutput(...).structured` hits. Demote the
scanner and that taint source stops existing; only the path-based
`sensitive_file` source survives. The trigger is content, not capability, so no
confinement change can absorb it.

### Two tiers are being treated as one verdict

- **Known-value pass** (`security/secrets/secret-normalize.ts:168`) matches the
  user's *actual stored plaintext*, registered on every vault load and set
  (`secrets.ts:115,212`), across raw, encoded and normalized views. This is
  exact-byte evidence — the same class as taint fingerprinting — and it covers a
  case taint does not: a secret the model obtained without ever calling a
  tainting tool.
- **Entropy and catalog-shape passes** (`entropy-detector.ts`,
  `credential-patterns.ts`, 27 shapes) are heuristics. Their false-positive cost
  is documented in three separate carve-outs written to contain it: the binary
  sniff at `tools/http-egress-guard.ts:335` ("a guaranteed false positive that
  bricks view_image / screen_capture / send_video"), the `structured`-vs-
  `matched` split at `data-lineage/paths.ts:236`, and the `memory_search`
  exemption at `sensitive-read-taint.ts:207`.

Collapsing both into one `clean` boolean is what makes the verdict impossible to
reason about: eighteen consumers read it, and they cannot tell exact-byte
evidence from a shape guess.

### Four sinks have no gate but the scanner

`clipboard_write`, `process_start`, `computer` typed text, and bridge media
forwarding reach `checkOutboundPayload` (`tools/http-egress-guard.ts:147`) with
no allowlist, no approval downgrade, and no taint coverage when the secret was
never read through a tainting tool. Any demotion needs a named replacement for
these four or it is a net reduction in safety.

### One bug defeats the scanner, taint and the canaries together

`security/secrets/secret-decode-engine.ts:293` peels inner runs with
`fresh.exec(v)` — the FIRST matching run per scheme per view — where it needs
`matchAll`. `BASE64_RUN_RE` matches 16 or more base64 characters, so sixteen
characters of padding consume the slot and the real blob is never enqueued.
Verified end-to-end against the built `dist/`:

    base64({"t": base64(key)})                  DETECTED
    base64({"pad":"a"*16,"t":base64(key)})      MISSED   (scanner)
    taint overlap, same padded payload          false    (egress allowed)
    canary, same padded payload                 false

`data-lineage/taint.ts:141` and `threat/canaries.ts:190` both expand the
outbound payload through `decodedPayloadViews`, so all three inherit it. The
completeness guard (`taint.ts:225`) limits the blast radius: a read over ~1024
normalized characters stays `complete:false` and keeps a presence floor, so
large secrets (SSH keys, kubeconfigs) are unaffected. Small ones — a `.env`
line, a vault value, a short token — are evadable.

This is not the unwinnable problem. It is a failure to scan runs the code
already knows how to decode.

### The guard has never demonstrably fired, and cannot currently be measured

Eight weeks of hash-chained audit (`~/.lax/audit/`, 2026-07-15 to 2026-09-07;
9052 `tool_executed`, 362 `tool_blocked`) contain zero `outbound-secret-scan`,
zero `canary_exfil_detected`, zero known-value hits. `ari-audit.db` (17772
events) agrees. Every one of the 362 blocks is the file-access/shell layer.

But `probeEgressGuard` writes no audit event on a block — only the canary path
does (`threat/canaries.ts:213`). So zero events means zero events *in the
channels that exist*, not zero fires. The egress guard is unmeasurable today,
and that is itself the finding.

## Decision

1. **Fix `exec` → `matchAll` with a per-view inner-run cap** before anything
   else. It is small, it is the single highest-value change available, and it
   closes the same hole in three subsystems at once. Its acceptance tests are
   the adversarial documents from the two reverted attempts.
2. **Instrument the egress guard.** Emit an audit event on every block and every
   near-miss. No decision about demoting a control should be made on evidence
   that cannot distinguish "never fired" from "never recorded".
3. **Split the verdict in two.** The known-value pass stays a control and should
   be strengthened. The entropy and catalog-shape passes become advisory, and
   the eighteen consumers are re-pointed at whichever tier they actually need —
   with the four unguarded sinks keeping control-tier coverage.
4. **Do not attempt another incremental fix of the shared-budget peel.** Its
   failure mode is silent and both prior attempts passed a green suite. If it is
   revisited, it needs a written threat model and an agreed scan-cost budget
   first.

## Consequences

The scanner stops being one boolean that eighteen call sites over-trust. The
known-value pass — the part backed by exact bytes — gains standing, and the
heuristic part stops being able to silently authorise an egress. Rejected
alternative: wholesale demotion to advisory, which would delete the
`source:"secret"` taint constructor and strip the only gate from four sinks.

## Open, not decided here

`security/secrets/secret-scanner.ts:128 containsSecrets` has zero consumers
anywhere and should be deleted. `canonical-loop/adapters/anthropic/helpers.ts:40`
defines a second, four-regex `redactSecrets` that shares a name with the
canonical one and has already drifted. A ~5 MB base64 image payload throws
`RangeError: Maximum call stack size exceeded` at `secret-decode-engine.ts:203`
before any verdict is produced.

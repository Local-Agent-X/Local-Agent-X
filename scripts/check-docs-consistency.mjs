#!/usr/bin/env node
/**
 * Guard high-risk runtime claims that have repeatedly survived past cutovers.
 * Historical PRDs, ADRs, and campaign records are intentionally excluded.
 * Every forbidden-claim family has stale/current self-test fixtures below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const currentDocs = [
  "README.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "THREAT-MODEL.md",
  "docs/known-issues.md",
  "docs/provider-auth.md",
  "docs/mcp-consuming-servers.md",
  "docs/runbooks/canonical-loop-rollback.md",
  "src/canonical-loop/README.md",
];

const claimRules = [
  {
    id: "approvals-live",
    label: "approvals described as dead or unshipped",
    patterns: [/(?:don't|do not) ship approvals/i, /\bapprovals? (?:are|is) (?:dead|unimplemented|not shipped)\b/i],
    stale: ["Approvals are dead.", "Do not ship approvals as a feature."],
    current: ["Issue-level fields are retired; risky tool calls use live approvals."],
  },
  {
    id: "effect-aware-retries",
    label: "tool retries described as universal or effect-agnostic",
    patterns: [
      /\b(?:all|every) (?:failed )?tool calls? (?:is |are )?(?:automatically )?retried\b/i,
      /\bnon-idempotent (?:tool calls?|mutations?) (?:are|may be) (?:automatically )?retried\b/i,
      /\btool retries (?:are|remain) effect-agnostic\b/i,
    ],
    stale: ["Every failed tool call is automatically retried.", "Tool retries are effect-agnostic."],
    current: ["Only transient failures with replay-safe effects are retried."],
  },
  {
    id: "external-data-paths",
    label: "memory or user data described as unconditionally local-only",
    patterns: [
      /\b(?:all|every) (?:user )?(?:data|memory)\b[^.\n]{0,80}\b(?:remains?|stays?|is|are) (?:strictly )?local(?:-only)?\b/i,
      /\bno data is sent to external services except\b/i,
      /\b(?:chat sessions|memory)\b[^.\n]{0,100}\bremain local\b/i,
      /\bmemory is local-only\b/i,
    ],
    stale: ["All user data remains local-only.", "No data is sent to external services except the LLM provider."],
    current: ["Data is stored locally by default; Agent Sync and invoked tools can use configured external services."],
  },
  {
    id: "keyed-audit-signing",
    label: "current audit chains described as unsigned or unkeyed",
    patterns: [
      /\baudit (?:logs?|trails?|chains?) (?:use|rely on|are protected by) (?:only )?(?:an )?unkeyed\b/i,
      /\baudit (?:logs?|trails?|chains?)\b[^.\n]{0,100}\bplain SHA-?256 without HMAC\b/i,
      /\baudit (?:logs?|trails?|chains?) (?:are|remain) unsigned\b/i,
    ],
    stale: ["Audit logs use only an unkeyed hash chain.", "Audit trails use plain SHA-256 without HMAC."],
    current: ["Current audit entries use keyed HMAC; prevHash links signatures."],
  },
  {
    id: "browser-modes",
    label: "shared browser identity described as the default",
    patterns: [/browser[^.\n]{0,100}(?:shared by default|defaults? to (?:an? )?shared)/i],
    stale: ["The browser is shared by default."],
    current: ["Browser identity defaults to isolated; advanced-shared is explicit."],
  },
  {
    id: "browser-secret-guards",
    label: "browser secret fill described as unrestricted",
    patterns: [
      /\bbrowser_fill_from_secret\b[^.\n]{0,120}\b(?:allows any origin|fills any field|needs no approval|works cross-origin)\b/i,
      /\bbrowser secret fills? (?:are|is) unrestricted\b/i,
    ],
    stale: ["browser_fill_from_secret allows any origin.", "Browser secret fills are unrestricted."],
    current: ["Secret fill checks the credential field, exact origin, and first-use approval."],
  },
  {
    id: "guarded-network",
    label: "guarded sandbox described as network-denying",
    patterns: [/\bguarded\b[^.\n]{0,100}\b(?:blocks|denies|disables|has no) (?:all )?(?:external )?network\b/i],
    stale: ["The guarded sandbox denies all external network."],
    current: ["Guarded retains network; strict seatbelt/bwrap and Docker deny it."],
  },
  {
    id: "recovery-backoff",
    label: "canonical crash recovery described as waiting policy backoff",
    patterns: [/\bcanonical (?:crash )?recovery\b[^.\n]{0,120}\b(?:waits|sleeps|delays|honors)\b[^.\n]{0,80}\b(?:retryPolicy\.)?backoff/i],
    stale: ["Canonical crash recovery waits for retryPolicy.backoffMs before requeue."],
    current: ["Canonical recovery requeues after lease expiry; it does not schedule policy backoff."],
  },
  {
    id: "canonical-only-routing",
    label: "legacy loop described as routable",
    patterns: [/new ops route to legacy/i, /flip.the.flag rollback/i, /routing decision \(legacy vs canonical\)/i],
    stale: ["New ops route to legacy after a flag flip."],
    current: ["Compatibility shims are hardwired to canonical."],
  },
  {
    id: "guarded-shell-default",
    label: "host shell described as the selected default",
    patterns: [/host by default/i, /default is [`*]*host/i, /bash runs on the host by default/i],
    stale: ["Bash runs on the host by default."],
    current: ["Guarded is selected by default and may visibly fall back to host."],
  },
  {
    id: "encrypted-provider-auth",
    label: "LAX-owned provider auth described as plaintext",
    patterns: [/LAX-owned[^.\n]{0,100}(?:auth|credentials?)[^.\n]{0,100}(?:stored|written|persisted)[^.\n]{0,30}plaintext/i],
    stale: ["LAX-owned provider credentials are stored as plaintext."],
    current: ["LAX-owned auth uses encrypted lax-auth-v2 envelopes; a CLI mirror can be temporary plaintext."],
  },
  {
    id: "signed-mcp-trust",
    label: "MCP trust described as TOFU-only",
    patterns: [/MCP[^.\n]{0,120}(?:TOFU[- ]only|only TOFU|trust on first use only)/i],
    stale: ["MCP supports trust on first use only."],
    current: ["MCP supports signed publisher manifests plus local trust fallback."],
  },
];

const sourceContracts = [
  ["live approval event", "src/approval-manager.ts", /type: "approval_requested"/],
  ["unknown tool effects fail closed", "src/resilience-policy.ts", /UNKNOWN_EFFECT[^\n]+non-idempotent/],
  ["retryable tool effects are enumerated", "src/resilience-policy.ts", /effect\.class === "read-only"[\s\S]{0,180}effect\.class === "keyed-mutation"/],
  ["memory enters Agent Sync", "src/sync/push-files.ts", /const memDir = join\(dataDir, "memory"\)/],
  ["Agent Sync pushes to a remote", "src/sync/index.ts", /await this\.git\("push", "-u", "origin", "HEAD:main"\)/],
  ["audit entries use keyed HMAC", "src/app-runtime/audit-signing.ts", /signAuditEntry[\s\S]{0,240}createHmac\("sha256", getAuditHmacKey\(\)\)/],
  ["continuity browser identity default", "src/config-schema.ts", /browserMode:[\s\S]{0,120}\.default\("continuity"\)/],
  ["all browser identity modes remain explicit", "src/config-schema.ts", /z\.enum\(\["isolated", "continuity", "advanced-shared"\]\)/],
  ["browser fill selector guard", "src/browser/secret-fill.ts", /reason: "selector_not_whitelisted"/],
  ["browser fill origin guard", "src/browser/secret-fill.ts", /reason: "origin_mismatch"/],
  ["browser fill approval guard", "src/browser/secret-fill.ts", /reason: "first_use_approval_required"/],
  ["guarded shell selection default", "src/config-schema.ts", /sandboxMode:[\s\S]{0,120}\.default\("guarded"\)/],
  ["guarded sandbox retains network", "src/sandbox/types.ts", /"guarded"[^\n]+network ALLOWED/],
  ["Settings statically presents guarded as default", "public/app.html", /option value="guarded" selected>[^<]+\(default\)/],
  ["recovery intentionally skips policy backoff", "src/canonical-loop/recovery.ts", /backoffMs[\s\S]{0,120}intentionally NOT honored/],
  ["canonical loop flag shim hardwired on", "src/canonical-loop/feature-flag.ts", /isCanonicalLoopEnabled[\s\S]{0,120}return true/],
  ["canonical-only submit decision", "src/canonical-loop/router.ts", /route: "canonical"[\s\S]{0,160}flagValue: true/],
  ["encrypted provider envelope", "src/auth/storage.ts", /ENVELOPE_FORMAT = "lax-auth-v2"/],
  ["signed MCP manifest trust", "src/mcp-client/manifest.ts", /MCPManifestTrust = "verified"/],
];

function matchingClaim(text) {
  for (const rule of claimRules) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) return { rule, match };
    }
  }
  return null;
}

const failures = [];
let fixtureCount = 0;
for (const rule of claimRules) {
  for (const fixture of rule.stale) {
    fixtureCount++;
    if (!rule.patterns.some((pattern) => pattern.test(fixture))) {
      failures.push(`self-test ${rule.id}: stale fixture was not rejected: ${JSON.stringify(fixture)}`);
    }
  }
  for (const fixture of rule.current) {
    fixtureCount++;
    if (rule.patterns.some((pattern) => pattern.test(fixture))) {
      failures.push(`self-test ${rule.id}: current fixture was rejected: ${JSON.stringify(fixture)}`);
    }
  }
}

for (const path of currentDocs) {
  const text = read(path);
  const hit = matchingClaim(text);
  if (!hit) continue;
  const line = text.slice(0, hit.match.index).split(/\r?\n/).length;
  failures.push(`${path}:${line}: ${hit.rule.label}: ${JSON.stringify(hit.match[0])}`);
}

for (const [label, path, pattern] of sourceContracts) {
  if (!pattern.test(read(path))) failures.push(`${path}: missing source contract: ${label}`);
}

if (failures.length) {
  console.error("check-docs-consistency: FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `check-docs-consistency: OK (${currentDocs.length} current docs, ${claimRules.length} claim rules, ` +
  `${fixtureCount} self-test fixtures, ${sourceContracts.length} source contracts)`,
);

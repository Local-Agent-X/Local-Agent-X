#!/usr/bin/env node
/**
 * Guard high-risk runtime claims that have repeatedly survived past cutovers.
 * Historical PRDs, ADRs, and campaign records are intentionally excluded.
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

const staleClaims = [
  ["approvals described as unshipped/dead", /don't ship approvals|approvals? (?:are|is) dead/i],
  ["legacy loop described as routable", /new ops route to legacy|flip.the.flag rollback|routing decision \(legacy vs canonical\)/i],
  ["shared browser described as the default", /browser[^.\n]{0,100}(?:shared by default|defaults? to (?:an? )?shared)/i],
  ["LAX-owned provider auth described as plaintext", /LAX-owned[^.\n]{0,100}(?:auth|credentials?)[^.\n]{0,100}(?:stored|written|persisted)[^.\n]{0,30}plaintext/i],
  ["host shell described as the default", /host by default|default is [`*]*host|bash runs on the host by default/i],
  ["MCP trust described as TOFU-only", /MCP[^.\n]{0,120}(?:TOFU[- ]only|only TOFU|trust on first use only)/i],
];

const failures = [];
for (const path of currentDocs) {
  const text = read(path);
  for (const [label, pattern] of staleClaims) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    failures.push(`${path}:${line}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

const sourceContracts = [
  ["guarded shell selection default", "src/config-schema.ts", /sandboxMode:[\s\S]{0,120}\.default\("guarded"\)/],
  ["isolated browser identity default", "src/config-schema.ts", /browserMode:[\s\S]{0,120}\.default\("isolated"\)/],
  ["canonical loop flag shim hardwired on", "src/canonical-loop/feature-flag.ts", /isCanonicalLoopEnabled[\s\S]{0,120}return true/],
  ["canonical-only submit decision", "src/canonical-loop/router.ts", /route: "canonical"[\s\S]{0,160}flagValue: true/],
  ["live approval event", "src/approval-manager.ts", /type: "approval_requested"/],
  ["encrypted provider envelope", "src/auth/storage.ts", /ENVELOPE_FORMAT = "lax-auth-v2"/],
  ["signed MCP manifest trust", "src/mcp-client/manifest.ts", /MCPManifestTrust = "verified"/],
];

for (const [label, path, pattern] of sourceContracts) {
  if (!pattern.test(read(path))) failures.push(`${path}: missing source contract: ${label}`);
}

if (failures.length) {
  console.error("check-docs-consistency: FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`check-docs-consistency: OK (${currentDocs.length} current docs, ${sourceContracts.length} source contracts)`);

// The docs that describe the code AS IT IS — what an agent or a reviewer reads
// before acting. Both doc checks run over this one list: check-docs-consistency
// (known-stale claim families) and check-doc-paths (every path named must
// exist). Historical records (docs/history/, docs/adr/, campaign logs, PRDs)
// are not here on purpose: they describe the past.
//
// Add a doc here when it becomes something an agent is pointed at; remove it
// when it moves to docs/history/.
export const currentDocs = [
  // Rules and maps
  "AGENTS.md",
  "src/AGENTS.md",
  "config/AGENTS.md",
  "packages/arikernel/AGENTS.md",
  "ARCHITECTURE.md",
  "README.md",
  "SECURITY.md",
  "THREAT-MODEL.md",
  // What the product agent reads every turn
  "config/agent-rules.md",
  "config/system-prompt.md",
  // Current reference docs
  "docs/agent-capabilities.md",
  "docs/ari-kernel.md",
  "docs/known-issues.md",
  "docs/learned-protocols.md",
  "docs/mcp-consuming-servers.md",
  "docs/provider-auth.md",
  "docs/release-qualification.md",
  "docs/runbooks/canonical-loop-rollback.md",
  // Module guides (≤25 lines each; also read by self_edit and background workers)
  "src/canonical-loop/README.md",
  "src/ari-kernel/AGENTS.md",
  "src/browser/AGENTS.md",
  "src/context/AGENTS.md",
  "src/memory/AGENTS.md",
  "src/ops/AGENTS.md",
  "src/providers/AGENTS.md",
  "src/security/AGENTS.md",
  "src/tool-execution/AGENTS.md",
  "src/tool-policy/AGENTS.md",
  "src/tools/AGENTS.md",
];

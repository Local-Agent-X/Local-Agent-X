// Tool taxonomy types + the derived TOOLS projection.
//
// The DATA lives in the unified policy table (src/tool-policy/tool-policies.data.ts),
// which joins each tool's kernel class, risk tier, explicit policy rule(s), and
// rate-limit cap in ONE entry. This module owns the taxonomy TYPES and projects
// the table's concrete-tool entries into TOOLS for the kernel/autonomy consumers:
//
//   kernel:  what defense pipeline runs at dispatch? (ari-kernel/evaluate.ts)
//   risk:    what does the user lose if this fires without approval?
//            (consumed by autonomy gate + approval-manager)
//
// TOOL_CLASS_MAP (ari-kernel/tool-class-map.ts) and TOOL_RISK (autonomy/risk.ts)
// remain the derived projections downstream consumers import. Adding a tool is a
// single edit to the table; a kernel tool missing a policy rule is caught by
// auditPolicyCoverage at boot (and the orphan test), not papered over by a
// silent risk-tier fallback.

import { deriveTools } from "./tool-policy/tool-policies.js";

export type KernelClass =
  | "file"
  | "http"
  | "shell"
  | "database"
  | "retrieval"
  | "secret-vault"
  | "internal";

export type ToolRisk =
  | "safe"             // read-only local / pure compute / catalog lookup
  | "workspace-write"  // creates or mutates files in workspace/ or LAX state
  | "network-read"     // outbound read-only (GET fetch, search, scrape)
  | "network-write"    // outbound state-changing (POST/PUT/DELETE)
  | "shell"            // subprocess spawn / arbitrary command execution
  | "destructive"      // irreversible delete / overwrite / cancel / uninstall
  | "money"            // bills a real-world account (payments, paid APIs)
  | "external-comms"   // sends a message a third party will see
  | "secrets";         // touches the credential vault — read, write, or fill-from

export interface ToolEntry {
  kernel: KernelClass;
  risk: ToolRisk;
}

// Kernel classes that gate at dispatch (taint analysis, capability check,
// audit log). "internal" runs entirely inside LAX state — dispatch skips
// the kernel. See ari-kernel/tool-class-map.ts:shouldGateInKernel.
export const GATED_KERNEL_CLASSES: ReadonlySet<KernelClass> = new Set<KernelClass>([
  "file", "http", "shell", "database", "retrieval", "secret-vault",
]);

/** Concrete-tool taxonomy, projected from the unified policy table. */
export const TOOLS: Record<string, ToolEntry> = deriveTools();

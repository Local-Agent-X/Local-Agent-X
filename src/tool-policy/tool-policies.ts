// Derivations over the unified TOOL_POLICIES table. The table (tool-policies.data.ts)
// is the single source of truth; these projections feed the downstream consumers
// that used to own their own scattered copy of the data:
//
//   deriveTools()        → TOOLS               (tool-registry.ts; kernel + risk taxonomy)
//   deriveDefaultRules() → DEFAULT_POLICY.rules (tool-policy/default-rules.ts)
//   deriveRateLimits()   → DEFAULT_LIMITS       (tool-execution/rate-limiter.ts)

import type { KernelClass, ToolRisk } from "../tool-registry.js";
import type { ToolPolicyRule } from "./types.js";
import { TOOL_POLICIES, type ToolPolicyEntry, type ToolRateLimit, type PathArgSpec } from "./tool-policies.data.js";

export { TOOL_POLICIES } from "./tool-policies.data.js";
export type { ToolPolicyEntry, ToolRateLimit, PathArgSpec } from "./tool-policies.data.js";

export interface DerivedToolEntry {
  kernel: KernelClass;
  risk: ToolRisk;
}

/** Concrete tools: every entry that declares a kernel class. Glob-pattern and
 *  global-rate-limit entries (no kernel) are excluded. */
export function deriveTools(): Record<string, DerivedToolEntry> {
  const out: Record<string, DerivedToolEntry> = {};
  for (const [name, entry] of Object.entries(TOOL_POLICIES)) {
    if (entry.kernel !== undefined && entry.risk !== undefined) {
      out[name] = { kernel: entry.kernel, risk: entry.risk };
    }
  }
  return out;
}

/** Flatten every entry's rules into the priority-sortable rule list, stamping
 *  the record key as the rule's `tool` pattern. Order within a priority is
 *  table order; ToolPolicy re-sorts by priority desc (stable) before matching. */
export function deriveDefaultRules(): ToolPolicyRule[] {
  const rules: ToolPolicyRule[] = [];
  for (const [tool, entry] of Object.entries(TOOL_POLICIES)) {
    for (const rule of entry.rules ?? []) rules.push({ ...rule, tool });
  }
  return rules;
}

/** Per-tool sliding-window caps, plus the global "*" cap. Shape matches
 *  tool-execution/rate-limiter's RateLimitConfig. */
export function deriveRateLimits(): Array<ToolRateLimit & { tool: string }> {
  const limits: Array<ToolRateLimit & { tool: string }> = [];
  for (const [tool, entry] of Object.entries(TOOL_POLICIES)) {
    if (entry.rateLimit) limits.push({ tool, ...entry.rateLimit });
  }
  return limits;
}

/** Tool → caller-supplied file path arg(s). SecurityLayer.evaluate() consumes
 *  this to gate every declared path through the file-access mode, so structured
 *  document tools (spreadsheet/document/pdf/presentation/ocr/image) are confined
 *  identically to the raw read/write/edit tools. */
export function derivePathArgs(): Record<string, PathArgSpec[]> {
  const out: Record<string, PathArgSpec[]> = {};
  for (const [tool, entry] of Object.entries(TOOL_POLICIES)) {
    if (entry.pathArgs && entry.pathArgs.length > 0) out[tool] = entry.pathArgs;
  }
  return out;
}

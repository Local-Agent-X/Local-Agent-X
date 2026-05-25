// ToolRisk — autonomy risk classification for tool calls.
//
// Orthogonal to TOOL_CLASS_MAP in ari-kernel: that map answers "does the
// kernel need to defend this?". This one answers "if this fires without
// asking, what does the USER stand to lose?". The profile gate consumes
// classifyToolRisk(name) and asks profiles.decide() to gate the call.
//
// Both maps are derived projections of the single TOOLS record in
// src/tool-registry.ts. The "twin-map drift" that used to require a
// runtime audit (auditRiskCoverage) is now a compile-time impossibility —
// the registry entry type requires both fields per tool.

import { createLogger } from "../logger.js";
import { TOOLS, type ToolRisk } from "../tool-registry.js";

const logger = createLogger("autonomy");

export type { ToolRisk } from "../tool-registry.js";

export const TOOL_RISK: Record<string, ToolRisk> = Object.fromEntries(
  Object.entries(TOOLS).map(([name, entry]) => [name, entry.risk]),
);

const _seenUnclassified = new Set<string>();

// Fail-safe: unmapped tools fall back to "shell" — most-restrictive
// non-destructive tier short of a real-world communication / money move.
// Reaching the fallback means a new tool was registered without being
// added to TOOLS in src/tool-registry.ts; the boot-time kernel coverage
// audit catches that case first.
export function classifyToolRisk(toolName: string): ToolRisk {
  const risk = TOOL_RISK[toolName];
  if (risk === undefined) {
    if (!_seenUnclassified.has(toolName)) {
      _seenUnclassified.add(toolName);
      logger.warn(`[autonomy] ${toolName} not in TOOLS — defaulting to "shell" (fail-safe). Add to TOOLS in src/tool-registry.ts.`);
    }
    return "shell";
  }
  return risk;
}

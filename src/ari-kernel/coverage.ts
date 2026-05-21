// Boot-time coverage audit. Mirrors auditPolicyCoverage in
// src/tool-policy.ts — surfaces missing TOOL_CLASS_MAP entries at startup
// so devs catch them before users hit the runtime block. Boot warns,
// runtime blocks.

import { createLogger } from "../logger.js";
import { TOOL_CLASS_MAP, TOOL_AUTONOMY_RISK } from "./tool-class-map.js";

const logger = createLogger("ari-kernel");

export interface KernelCoverageReport {
  totalTools: number;
  covered: string[];
  uncovered: string[];
}

export function auditKernelCoverage(toolNames: string[]): KernelCoverageReport {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const name of toolNames) {
    if (TOOL_CLASS_MAP[name] !== undefined) covered.push(name);
    else uncovered.push(name);
  }
  return { totalTools: toolNames.length, covered, uncovered };
}

export function printKernelCoverageReport(report: KernelCoverageReport): void {
  logger.info(`\n  ── AriKernel Coverage ──`);
  if (report.uncovered.length === 0) {
    logger.info(`  \x1b[36mℹ\x1b[0m All ${report.totalTools} registered tools are classified in TOOL_CLASS_MAP\n`);
    return;
  }
  logger.error(`  \x1b[31m✖\x1b[0m ${report.uncovered.length} of ${report.totalTools} tools missing from TOOL_CLASS_MAP:`);
  for (const name of report.uncovered) logger.error(`    - ${name}`);
  logger.error(`  These will FAIL-CLOSED at runtime (default block). Classify each as a gated class (file/http/shell/database/retrieval/secret-vault) or "internal" in src/ari-kernel/tool-class-map.ts.\n`);
}

// Twin-map invariant: every key in TOOL_CLASS_MAP must have a matching
// TOOL_AUTONOMY_RISK entry. Both maps are hardcoded — any divergence is
// a programming error, never a runtime config issue. We throw rather
// than warn because there is no recovery path: a missing autonomy entry
// silently falls back to "shell", which over-restricts safe tools and
// leaks past the profile gate before the gap is noticed.
export function auditAutonomyCoverage(): void {
  const missing: string[] = [];
  for (const toolName of Object.keys(TOOL_CLASS_MAP)) {
    if (TOOL_AUTONOMY_RISK[toolName] === undefined) missing.push(toolName);
  }
  if (missing.length === 0) {
    logger.info(`  \x1b[36mℹ\x1b[0m All ${Object.keys(TOOL_CLASS_MAP).length} TOOL_CLASS_MAP entries have an autonomy risk\n`);
    return;
  }
  const detail = missing.map(n => `    - ${n}`).join("\n");
  const msg = `TOOL_AUTONOMY_RISK is missing ${missing.length} entries that exist in TOOL_CLASS_MAP:\n${detail}\nAdd each to TOOL_AUTONOMY_RISK in src/ari-kernel/tool-class-map.ts.`;
  logger.error(`  \x1b[31m✖\x1b[0m ${msg}\n`);
  throw new Error(`[ari] auditAutonomyCoverage: ${msg}`);
}

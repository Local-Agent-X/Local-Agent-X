// Boot-time coverage audit. Mirrors auditPolicyCoverage in
// src/tool-policy.ts — surfaces missing TOOL_CLASS_MAP entries at startup
// so devs catch them before users hit the runtime block. Boot warns,
// runtime blocks.

import { createLogger } from "../logger.js";
import { TOOL_CLASS_MAP } from "./tool-class-map.js";

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

// auditAutonomyCoverage moved to src/autonomy/risk.ts as auditRiskCoverage
// alongside the canonical TOOL_RISK map. Server boot wires it from there.

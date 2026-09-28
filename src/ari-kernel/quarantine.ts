// What the kernel's run state says after a deny, read off the firewall scope.
//
// A kernel deny arrives as one string ("behavioral rule triggered by egress
// attempt. Run has been quarantined." / "Run entered restricted mode ... after
// N denied sensitive actions") that names neither the rule that fired nor what
// clears it. The rule id, its reason and the trigger are on the scope's
// QuarantineInfo; this module is the one place that reads them, so the block
// the model and the user see can say which rule fired and whether anything
// they do can clear it (2026-09-27: two turns were narrated as "locked until
// you click Declassify" for quarantines no declassify could touch).

import type { KernelQuarantine } from "../types.js";
import { getFirewall } from "./state.js";
import { isSensitivePath } from "../data-lineage/index.js";
import { resolveAgentPath } from "../workspace/paths.js";

/** Rules whose match REQUIRES the web/rag/email taint labels LAX hands the
 *  kernel from its session taint registry. A declassify clears that registry,
 *  so these are the quarantines a "Declassify & retry" can actually end. Every
 *  other rule (and the denied-action threshold) keys on run signals the kernel
 *  derives itself — a sensitive-looking path, a secrets-looking URL, an earlier
 *  denial — and no user control clears those; the scope ends with the op. */
export const TAINT_KEYED_KERNEL_RULES: ReadonlySet<string> = new Set([
  "web_taint_sensitive_probe",
  "tainted_database_write",
  "tainted_shell_with_data",
]);

export const SENSITIVE_READ_RULE = "sensitive_read_then_egress";

/** The quarantine behind the scope's restricted mode, or null when the run is
 *  not restricted. `trigger` is "restricted" when the quarantine predates THIS
 *  call (a cascade denial), else the quarantine's own trigger. */
export function readKernelQuarantine(scopeId: string | undefined, justRaised: boolean): KernelQuarantine | null {
  const fw = getFirewall(scopeId) as (ReturnType<typeof getFirewall> & {
    isRestricted?: boolean;
    restrictedAt?: string | null;
    runStateCounters?: { deniedActions: number };
    quarantineInfo?: {
      triggerType: "threshold" | "behavioral_rule";
      ruleId?: string;
      reason: string;
      timestamp: string;
      matchedEvents?: Array<{ type: string; metadata?: Record<string, unknown> }>;
    } | null;
  }) | null;
  if (!fw?.isRestricted) return null;
  const info = fw.quarantineInfo;
  const read = info?.matchedEvents?.find((e) => e.type === "sensitive_read_attempt" || e.type === "sensitive_read_allowed");
  const matchedPath = typeof read?.metadata?.path === "string" ? read.metadata.path : undefined;
  return {
    trigger: justRaised ? (info?.triggerType ?? "behavioral_rule") : "restricted",
    rule: info?.ruleId,
    reason: info?.reason ?? "run is in restricted mode",
    restrictedAt: fw.restrictedAt ?? info?.timestamp ?? new Date().toISOString(),
    deniedActions: fw.runStateCounters?.deniedActions ?? 0,
    ...(matchedPath ? { matchedPath } : {}),
  };
}

/**
 * Did sensitive_read_then_egress fire on a path that is NOT a secret? The
 * kernel's sensitive-path matcher is an unanchored substring (/secret|token|
 * password|.../) over EVERY file action, reads and writes alike, so writing
 * `scripts/set-unsub-secret.mjs` counted as a sensitive read and the next
 * outbound POST quarantined the whole turn (2026-09-28 02:51). LAX's anchored
 * detector is the canonical answer, exactly as it already is for the kernel's
 * own sensitive-file deny (isKernelSensitiveFileFalsePositive). A genuine
 * secret path (~/.ssh/id_rsa, .env) returns false and the quarantine stands.
 */
export function isSensitiveReadQuarantineFalsePositive(q: KernelQuarantine | null): boolean {
  if (!q || q.rule !== SENSITIVE_READ_RULE || !q.matchedPath) return false;
  return !isSensitivePath(resolveAgentPath(q.matchedPath));
}

// What the kernel's run state says after a deny, read off the firewall scope.
//
// A kernel deny arrives as one string ("Action 'http.post' refused by run rule
// sensitive_read_then_egress: …" / "Run entered restricted mode ... after N
// denied sensitive actions") that says neither where the run now stands nor
// what clears it. The rule id, its reason, the counters and the trigger are on
// the scope (lastRuleDenial, QuarantineInfo); this module is the one place
// that reads them, so the block the model and the user see can say which rule
// fired, that only this call was refused (or that the turn is restricted), and
// whether anything they do can clear it (2026-09-27: two turns were narrated
// as "locked until you click Declassify" for quarantines no declassify could
// touch).

import type { KernelQuarantine } from "../types.js";
import { getFirewall } from "./state.js";

/** Rules whose match REQUIRES the web/rag/email taint labels LAX hands the
 *  kernel from its session taint registry. A declassify clears that registry,
 *  so these are the refusals a "Declassify & retry" can actually end. Every
 *  other rule (and the denied-action threshold) keys on run signals the kernel
 *  derives itself — a sensitive-looking path, an earlier denial — and no user
 *  control clears those; the scope ends with the op. */
export const TAINT_KEYED_KERNEL_RULES: ReadonlySet<string> = new Set([
  "web_taint_sensitive_probe",
  "tainted_database_write",
  "tainted_shell_with_data",
]);

/** The rule a kernel deny names when a behavioral rule refused the call
 *  (arikernel behavioral-rules.ts ruleDenialText). */
const RULE_IN_REASON = /refused by run rule ([a-z0-9_]+):/i;

type MatchedEvent = { type: string; metadata?: Record<string, unknown> };

interface FirewallRunState {
  isRestricted?: boolean;
  restrictedAt?: string | null;
  runStateCounters?: { deniedActions: number };
  quarantineInfo?: {
    triggerType: "threshold" | "external";
    ruleId?: string;
    reason: string;
    timestamp: string;
    matchedEvents?: MatchedEvent[];
  } | null;
  lastRuleDenial?: {
    ruleId: string;
    reason: string;
    deniedActions: number;
    threshold: number;
    matchedEvents: MatchedEvent[];
  } | null;
}

function matchedPath(events: MatchedEvent[] | undefined): { matchedPath?: string } {
  const read = events?.find((e) => e.type === "sensitive_read_attempt" || e.type === "sensitive_read_allowed");
  const path = read?.metadata?.path;
  return typeof path === "string" ? { matchedPath: path } : {};
}

/**
 * The kernel run state behind a deny of THIS call, or null when the kernel
 * refused nothing of its own. `denyReason` is the kernel's text for the deny:
 * a rule refusal is attributed to the call only when that text names the rule
 * the scope last refused by, so a policy deny never borrows an earlier rule's
 * record. With `justRaised` false only the standing state is read — the run
 * is restricted, or it is not.
 */
export function readKernelQuarantine(scopeId: string | undefined, justRaised: boolean, denyReason = ""): KernelQuarantine | null {
  const fw = getFirewall(scopeId) as (ReturnType<typeof getFirewall> & FirewallRunState) | null;
  if (!fw) return null;
  const named = justRaised ? RULE_IN_REASON.exec(denyReason)?.[1] : undefined;
  const last = fw.lastRuleDenial ?? null;
  const denial = named && last && last.ruleId === named ? last : null;
  if (fw.isRestricted) {
    const info = fw.quarantineInfo;
    return {
      trigger: justRaised ? (info?.triggerType ?? "threshold") : "restricted",
      rule: info?.ruleId ?? denial?.ruleId,
      reason: info?.reason ?? "run is in restricted mode",
      restrictedAt: fw.restrictedAt ?? info?.timestamp ?? new Date().toISOString(),
      deniedActions: fw.runStateCounters?.deniedActions ?? 0,
      ...(denial ? { threshold: denial.threshold } : {}),
      ...matchedPath(denial?.matchedEvents ?? info?.matchedEvents),
    };
  }
  if (!denial) return null;
  return {
    trigger: "behavioral_rule",
    rule: denial.ruleId,
    reason: denial.reason,
    deniedActions: denial.deniedActions,
    threshold: denial.threshold,
    ...matchedPath(denial.matchedEvents),
  };
}

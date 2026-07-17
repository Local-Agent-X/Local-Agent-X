/**
 * Boot-time reconciliation of the on-disk policy snapshot (~/.lax/tool-policy.json)
 * with the code defaults (DEFAULT_POLICY, derived from tool-policies.data.ts).
 *
 * The on-disk file is a snapshot of the defaults at first run, plus any edits
 * the user has made (the Settings UI toggles a rule's decision by id; users may
 * also hand-edit the file — types.ts explicitly points them at it). The merge
 * must therefore answer, per rule: "did the USER set this, or is it just a
 * stale copy of an old default?" — user edits are sacred, stale defaults must
 * refresh, silently keeping an old default is the bug (a decision flipped in
 * code never reached existing installs; new installs and old installs ran
 * different policy forever).
 *
 * Mechanism: every rule written FROM CODE is stamped with `snapshotHash` — a
 * hash of its user-ownable fields (decision, priority, constraints) as code
 * wrote them. At merge time:
 *   - fields still match the stamp → untouched → code owns the rule wholesale
 *     (decision, reason, pattern, constraints all refresh; hash restamped);
 *   - fields drifted from the stamp → the user edited it (UI or hand) → their
 *     decision/priority/constraints are preserved; only the code-owned
 *     matching keys (tool/action) refresh, as before;
 *   - no stamp (legacy file): if the decision equals a KNOWN RETIRED default
 *     (LEGACY_DEFAULT_DECISIONS) it is a stale snapshot → refresh; if the
 *     fields already equal the current default → stamp it (bootstraps
 *     tracking, no behavior change); anything else is ambiguous → preserved
 *     forever (fail safe: never overwrite a possibly-deliberate user setting).
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createLogger } from "../logger.js";
import { DEFAULT_POLICY } from "./default-rules.js";
import type { ToolPolicyConfig, ToolPolicyRule } from "./types.js";

const logger = createLogger("tool-policy");

/** Default decisions that were RETIRED in code under a stable rule id. A
 *  legacy (unstamped) snapshot rule still carrying one of these decisions is
 *  provably an old default — not a user edit — and is refreshed to the current
 *  default. Append here whenever a default rule's decision changes, or
 *  existing installs will keep the old decision forever. */
const LEGACY_DEFAULT_DECISIONS: Record<string, ReadonlyArray<ToolPolicyRule["decision"]>> = {
  // cf977d9a: browser.evaluate went confirm → allow (autonomous by default).
  "flag-browser-evaluate": ["confirm"],
};

/** Deterministic JSON — object keys sorted at every depth. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of the USER-OWNABLE fields — the ones a Settings toggle or hand-edit
 *  changes. Matching keys (tool/action/argMatch) and display text (reason)
 *  are code-owned and deliberately excluded: refreshing them must not read
 *  as a user edit. */
export function snapshotHashOf(rule: Pick<ToolPolicyRule, "decision" | "priority" | "constraints">): string {
  const payload = canonical({
    decision: rule.decision,
    priority: rule.priority ?? 0,
    constraints: rule.constraints ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** A default rule as code writes it into the snapshot: stamped. */
function stampedDefault(def: ToolPolicyRule): ToolPolicyRule {
  return { ...def, snapshotHash: snapshotHashOf(def) };
}

/** DEFAULT_POLICY with every rule stamped — what first-run writes to disk. */
export function stampedDefaultPolicy(): ToolPolicyConfig {
  return {
    defaultDecision: DEFAULT_POLICY.defaultDecision,
    rules: DEFAULT_POLICY.rules.map(stampedDefault),
  };
}

/** Merge user policy with defaults — user edits take priority, stale default
 *  snapshots refresh from code, missing default rules are added. */
export function mergeWithDefaults(user: ToolPolicyConfig, policyPath?: string): ToolPolicyConfig {
  const defaultsById = new Map(DEFAULT_POLICY.rules.map((r) => [r.id, r]));
  const userIds = new Set(user.rules.map((r) => r.id));

  let patternRefreshed = 0;
  let decisionRefreshed = 0;
  let stamped = 0;

  /** Existing behavior for user-owned rules: only the code-owned matching
   *  key (`tool`, `action`) refreshes; everything the user owns is kept. */
  const refreshPattern = (u: ToolPolicyRule, def: ToolPolicyRule): ToolPolicyRule => {
    if (def.tool === u.tool && def.action === u.action) return u;
    patternRefreshed++;
    return { ...u, tool: def.tool, action: def.action };
  };

  const reconciled = user.rules.map((u) => {
    const def = defaultsById.get(u.id);
    if (!def) return u; // genuinely user-authored rule — untouched

    if (u.snapshotHash) {
      if (snapshotHashOf(u) === u.snapshotHash) {
        // Untouched since code last wrote it — code owns it wholesale.
        const fresh = stampedDefault(def);
        if (fresh.snapshotHash !== u.snapshotHash) decisionRefreshed++;
        return fresh;
      }
      // User diverged from what code wrote — preserve their fields. The stale
      // stamp stays: it keeps recording "not what code wrote", which is the fact.
      return refreshPattern(u, def);
    }

    // Legacy rule (written before stamping existed).
    if (LEGACY_DEFAULT_DECISIONS[u.id]?.includes(u.decision) && u.decision !== def.decision) {
      decisionRefreshed++;
      return stampedDefault(def);
    }
    if (snapshotHashOf(u) === snapshotHashOf(def)) {
      // Already in sync with the current default — adopt the code copy
      // (stamps it, syncs reason/pattern; no behavior change).
      stamped++;
      return stampedDefault(def);
    }
    // Ambiguous: differs from the current default and we cannot prove it is a
    // stale snapshot. Fail safe — treat as a user edit, preserve forever.
    return refreshPattern(u, def);
  });

  const missing = DEFAULT_POLICY.rules.filter((r) => !userIds.has(r.id)).map(stampedDefault);
  if (missing.length > 0) {
    logger.info(`[policy] Merging ${missing.length} default rules not in user policy`);
  }
  if (patternRefreshed > 0) {
    logger.info(`[policy] Refreshed ${patternRefreshed} default rule(s) whose matching pattern changed in code`);
  }
  if (decisionRefreshed > 0) {
    logger.info(`[policy] Refreshed ${decisionRefreshed} default rule(s) whose decision changed in code (user-untouched snapshots)`);
  }

  const merged: ToolPolicyConfig = {
    defaultDecision: user.defaultDecision,
    rules: [...reconciled, ...missing],
  };
  // Persist so new/refreshed/stamped rules survive restarts and self-heal the snapshot.
  if ((missing.length > 0 || patternRefreshed > 0 || decisionRefreshed > 0 || stamped > 0) && policyPath) {
    try {
      writeFileSync(policyPath, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 });
      logger.info(`[policy] Saved merged policy (${merged.rules.length} rules) to ${policyPath}`);
    } catch {}
  }
  return merged;
}

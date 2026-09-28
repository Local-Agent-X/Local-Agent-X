// The block a kernel deny becomes: what the model reads, what the chat renders,
// and what the trace records.
//
// Two turns on 2026-09-27/28 were quarantined by kernel run rules that no user
// action can clear (a secrets-looking URL followed by a POST; a "secret"-named
// script write followed by a POST), and both were reported with the recovery
// written for a TAINT deny — "click Declassify & retry". The button clears the
// session taint registry, which had nothing in it, and the kernel run state it
// could never touch was discarded with the op anyway. So the recovery is chosen
// off the verdict: declassify is offered only when LAX's own taint labels are
// what the kernel judged; a run-rule quarantine says what fired, that nothing
// needs clicking, and that the next message starts clean.

import { USER_HINTS, type KernelQuarantine, type ToolResult } from "../types.js";
import { TAINT_KEYED_KERNEL_RULES, type AriVerdict } from "../ari-kernel/index.js";
import type { EgressBlocker } from "./egress-gates.js";

const UNTRUSTED_TAINT: ReadonlySet<string> = new Set(["web", "rag", "email"]);

export const KERNEL_TAINT_RECOVERY =
  "The kernel policy denies this outbound action because the session carries untrusted-input taint from an earlier web/email/file read. To clear the taint, ask the user to click \"Declassify & retry\" on this blocked card in the chat — that button is the only declassify control. Do not just retry the same call.";

function quarantineRecovery(q: KernelQuarantine): string {
  const fired = q.rule ? `run rule ${q.rule}` : `denied-action threshold (${q.deniedActions} denials this turn)`;
  const lead = q.trigger === "restricted"
    ? `The security kernel has kept this turn in restricted mode since ${q.restrictedAt} (${fired}: ${q.reason}), so this call was refused too.`
    : `The security kernel's ${fired} quarantined this turn: ${q.reason}.`;
  return `${lead} For the rest of THIS turn the kernel refuses outbound writes, shell and file writes; read-only calls still work. ` +
    "No session taint is involved, so there is nothing the user can click or clear, and the state is not permanent: the kernel run state belongs to this turn and the next user message starts clean. " +
    "Stop retrying blocked calls now — report what was completed and exactly which step this rule stopped, then end the turn so the user can reply to continue.";
}

export interface KernelDeny {
  clearable?: "declassify";
  recovery: string;
  /** Header-visible scalars + the nested quarantine record. */
  meta: Record<string, unknown>;
}

/**
 * Decide the block's shape from the verdict and the taint labels the kernel was
 * actually handed. Clearable only when untrusted-content taint went in AND the
 * kernel's decision is one that taint drives (a taint policy rule, or one of
 * the taint-keyed behavioral rules) — those are the quarantines a declassify
 * ends. A run-rule quarantine keyed on the kernel's own signals is not.
 */
export function kernelDeny(verdict: AriVerdict, kernelTaintLabels: readonly string[]): KernelDeny {
  const q = verdict.quarantine;
  const taintIn = kernelTaintLabels.some((s) => UNTRUSTED_TAINT.has(s));
  const taintDriven = !q || (q.rule !== undefined && TAINT_KEYED_KERNEL_RULES.has(q.rule));
  const clearable = taintIn && taintDriven ? ("declassify" as const) : undefined;
  const meta: Record<string, unknown> = {};
  if (q) {
    meta.rule = q.rule ?? q.trigger;
    meta.trigger = q.trigger;
    meta.scope = clearable ? "session-memory" : "operation";
    meta.quarantine = q;
  }
  return {
    clearable,
    recovery: clearable || !q ? KERNEL_TAINT_RECOVERY : quarantineRecovery(q),
    meta,
  };
}

/** The kernel's line in the egress aggregate (SC-10). */
export function kernelDenyBlocker(verdict: AriVerdict, kernelTaintLabels: readonly string[]): EgressBlocker {
  const d = kernelDeny(verdict, kernelTaintLabels);
  return {
    layer: "arikernel",
    label: "ARI kernel",
    reason: verdict.reason,
    recovery: d.recovery,
    userHint: verdict.userHint ?? USER_HINTS.policy,
    meta: d.meta,
    ...(d.clearable ? { clearable: d.clearable } : {}),
  };
}

/**
 * The envelope for a kernel deny of a NON-egress tool (shell, file, database —
 * typically the restricted-mode cascade after a quarantine). It used to be a
 * raw two-line string with no status header, so the canonical event log and
 * the reloaded chat both recorded the refused call as "ok" (2026-09-28: seven
 * refused shell calls, all logged ok, none with a notice).
 */
export function kernelDenyResult(verdict: AriVerdict, kernelTaintLabels: readonly string[]): ToolResult {
  const d = kernelDeny(verdict, kernelTaintLabels);
  return {
    content: `BLOCKED by ARI kernel: ${verdict.reason}`,
    isError: true,
    status: "blocked",
    metadata: {
      layer: "arikernel",
      ...d.meta,
      recovery: d.recovery,
      userHint: verdict.userHint ?? USER_HINTS.policy,
      ...(d.clearable ? { clearable: d.clearable } : {}),
    },
  };
}

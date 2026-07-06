/**
 * Enforced plan mode — a session-scoped STANDING mandate layered on the per-op
 * instruction ledger. While enforced for a session, the mutation capability
 * classes below are forbidden for every op in that session, and only an
 * explicit user action (the Plan toggle over the chat WS — the approval event)
 * can lift it. The model cannot clear it: exit_plan_mode refuses while
 * enforced, and pre-dispatch hard-denies the capability classes regardless of
 * what the model calls.
 *
 * Same fail-open contract as the op ledger: an unknown session is permissive.
 * State is process-local (mirrors the op-ledger registry); a server restart
 * drops plan mode, which fails SAFE for the user — nothing gets blocked.
 */
import type { CapabilityClass } from "../../tool-registry.js";
import { opForbidsCapability } from "./ledger.js";

/**
 * Mutation classes plan mode forbids. Egress + sensitive-read stay allowed —
 * planning is research. Mutating SHELL commands are additionally blocked by
 * pre-dispatch's shell-write escape, which fires whenever workspace-write is
 * forbidden (user-stated or plan mode), so read-only shell keeps working.
 */
export const PLAN_MODE_PROHIBITIONS: readonly CapabilityClass[] = ["workspace-write"];

const ENFORCED_SESSIONS = new Set<string>();

/** Returns true when the call actually changed state (drives the broadcast). */
export function setEnforcedPlanMode(sessionId: string, on: boolean): boolean {
  const was = ENFORCED_SESSIONS.has(sessionId);
  if (on) ENFORCED_SESSIONS.add(sessionId);
  else ENFORCED_SESSIONS.delete(sessionId);
  return was !== on;
}

export function isEnforcedPlanMode(sessionId: string): boolean {
  return ENFORCED_SESSIONS.has(sessionId);
}

/** False (permissive) unless the session is in enforced plan mode AND `cls`
 *  is one of the plan-mode mutation classes. */
export function planModeForbidsCapability(
  sessionId: string | undefined,
  cls: CapabilityClass,
): boolean {
  if (!sessionId || !ENFORCED_SESSIONS.has(sessionId)) return false;
  return PLAN_MODE_PROHIBITIONS.includes(cls);
}

/**
 * Combined mandate check for the persistence guards: is `cls` forbidden for
 * this op, either by the op's own ledger (user-stated constraint) or by the
 * session's enforced plan mode? Guards that push the model toward writing
 * (premature-completion, open-steps, cleanup-verify, …) must stand down under
 * EITHER source — nudging toward a call pre-dispatch will hard-deny just
 * burns turns.
 */
export function capabilityForbiddenForOp(
  op: { id: string; canonical?: { sessionId?: string | null } },
  cls: CapabilityClass,
): boolean {
  if (opForbidsCapability(op.id, cls)) return true;
  return planModeForbidsCapability(op.canonical?.sessionId ?? undefined, cls);
}

/** Test-only: drop every session's enforced flag. */
export function _resetEnforcedPlanMode(): void {
  ENFORCED_SESSIONS.clear();
}

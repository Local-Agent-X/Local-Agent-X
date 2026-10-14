/**
 * A delegated worker's session lineage: its tool runtime runs under its OWN
 * session (the op id — the key for allowed paths, the work root, approvals,
 * taint, trash scope), while the conversation that submitted it stays the
 * owner of its browser tabs, its progress cards and the trust marks its
 * result carries back. These two functions are the whole seam between the
 * two ids; nothing else maps one to the other.
 *
 *   bind     at install/recovery: the worker drives the parent chat's browser
 *            (session-owner registry — the same flattening agent runs get in
 *            server/handler-events.ts), and the browser egress scan merges the
 *            worker's lineage into that bucket before any page request.
 *   release  at terminal: whatever the worker read or ingested follows its
 *            result into the parent — the agency precedent
 *            (agency/handler-completion.ts pushCompletionToParent) — and the
 *            owner record is dropped.
 */
import { propagateTaint } from "../data-lineage/index.js";
import { propagateExternalIngestion } from "../data-lineage/external.js";
import { propagateTaskArtifacts } from "../data-lineage/task-artifacts.js";
import { clearSessionOwner, registerChildSessionOwner } from "../browser/session-owner-registry.js";
import type { Op } from "../ops/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.delegated-session-lineage");

export function bindDelegatedSessionLineage(runtimeSessionId: string, parentSessionId: string | undefined): void {
  if (!parentSessionId || parentSessionId === runtimeSessionId) return;
  registerChildSessionOwner(runtimeSessionId, parentSessionId);
}

/** Terminal cleanup for an op whose descriptor names a parent session. A
 *  no-op for every other op shape (chat turns, app builds, unattended
 *  workers, harness verifiers). Never throws: the op is already terminal. */
export function releaseDelegatedSessionLineage(op: Op): void {
  const descriptor = op.runtimeDescriptor;
  if (descriptor?.kind !== "delegated-op" || descriptor.adapter !== "provider-exact") return;
  const { sessionId, parentSessionId } = descriptor;
  if (!sessionId || !parentSessionId || sessionId === parentSessionId) return;
  try {
    const taints = propagateTaint(sessionId, parentSessionId);
    const ingested = propagateExternalIngestion(sessionId, parentSessionId);
    const artifacts = propagateTaskArtifacts(sessionId, parentSessionId);
    if (taints > 0 || ingested || artifacts > 0) {
      logger.info(`[lineage] ${op.id} → ${parentSessionId}: ${taints} taint label(s), ingestion ${ingested ? "marked" : "clean"}, ${artifacts} artifact(s)`);
    }
  } catch (e) {
    logger.error(`[lineage] propagation failed for ${op.id} → ${parentSessionId}: ${(e as Error).message}`);
  }
  clearSessionOwner(sessionId);
}

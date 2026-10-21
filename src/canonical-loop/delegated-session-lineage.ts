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
import { clearSessionOwner, registerChildSessionOwner, resolveBrowserSessionId } from "../browser/session-owner-registry.js";
import type { Op } from "../ops/types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.delegated-session-lineage");

export function bindDelegatedSessionLineage(runtimeSessionId: string, parentSessionId: string | undefined): void {
  if (!parentSessionId || parentSessionId === runtimeSessionId) return;
  registerChildSessionOwner(runtimeSessionId, parentSessionId);
  inheritSessionLineage(runtimeSessionId, parentSessionId);
}

/**
 * What the parent has read or ingested is the child's too, from the start:
 * a worker or agent spawned from a tainted session carries the taint (its
 * fingerprints included, so the child's egress clears what the parent's
 * would) and the parent's external-ingestion mark. Without this a session
 * whose own write was refused could hand the same bytes to a fresh child
 * session and have it sent from there (red team 2026-10-13, A4). The
 * agency run driver (server/handler-events.ts) calls this for agent runs;
 * `bind` above does for delegated ops.
 */
export function inheritSessionLineage(childSessionId: string, parentSessionId: string | undefined): void {
  if (!parentSessionId || parentSessionId === childSessionId) return;
  const taints = propagateTaint(parentSessionId, childSessionId);
  const ingested = propagateExternalIngestion(parentSessionId, childSessionId);
  if (taints > 0 || ingested) {
    logger.info(`[lineage] ${parentSessionId} → ${childSessionId}: inherits ${taints} taint label(s), ingestion ${ingested ? "marked" : "clean"}`);
  }
}

/**
 * The session an op's tool runtime records taint under: the delegated
 * descriptor's `sessionId` (the op id, for a delegated worker), else the
 * op's canonical session. The relay that lands a container's forwarded
 * taint must be keyed by THIS id — the forwarder sends whatever key the
 * container's registry recorded — not by the chat that submitted the op.
 */
export function executionSessionOf(op: Op): string {
  const descriptor = op.runtimeDescriptor as { kind?: string; sessionId?: string } | undefined;
  if (descriptor?.kind === "delegated-op" && descriptor.sessionId) return descriptor.sessionId;
  return op.canonical?.sessionId ?? op.id;
}

/**
 * A container worker's lineage on the host, before its relay opens: its
 * execution session is the submitting chat's child (so taint it forwards
 * aggregates into the chat's browser session, as an in-process worker's
 * does) and starts with the chat's own taint and ingestion. Returns the two
 * ids the relay is opened with: the execution session that owns forwarded
 * lineage, and the chat's browser session that owns the views.
 */
export function bindContainerSessionLineage(op: Op): { executionSessionId: string; browserSessionId: string } {
  const chatSessionId = op.canonical?.sessionId;
  if (!chatSessionId) throw new Error("container projection is missing its owning session");
  const executionSessionId = executionSessionOf(op);
  bindDelegatedSessionLineage(executionSessionId, chatSessionId);
  return { executionSessionId, browserSessionId: resolveBrowserSessionId(chatSessionId) };
}

export function releaseContainerSessionLineage(op: Op): void {
  const executionSessionId = executionSessionOf(op);
  if (executionSessionId !== op.canonical?.sessionId) clearSessionOwner(executionSessionId);
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

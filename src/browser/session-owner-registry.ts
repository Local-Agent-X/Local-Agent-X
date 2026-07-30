/**
 * Session → owner registry.
 *
 * At the browser tool layer the only trusted identity is `args._sessionId`
 * (stamped in tool-execution/resolve-tool.ts). There is no map from a session
 * to the agent that owns it, nor to the root chat whose tabs it should
 * drive. This registry adds exactly that — a small in-memory map populated at
 * the run-prep sites (agent runs in server/handler-events.ts, scheduled runs in
 * background-jobs/cron-runner.ts). Main-chat sessions are left unregistered and
 * resolve to the "default" profile.
 *
 * The three-rung profile precedence (per-run override → per-project roster →
 * agent template default) is resolved UPSTREAM, where the definition, roster,
 * and invoke options are available.
 */

import { getTaintSummary, propagateTaint } from "../data-lineage/index.js";
import { getSessionCanaries, registerSessionCanaries } from "../threat/canaries.js";
import {
  browserContainerRelayActivated,
  CONTAINER_BROWSER_ACTING_SESSION,
  CONTAINER_BROWSER_OWNER_SESSION,
} from "./container-bridge-transport.js";

export const DEFAULT_BROWSER_SESSION_ID = "default";

export interface SessionOwner {
  /** Agent definition id that owns this session, when a spawned agent (not
   *  main chat) drives it. */
  agentId?: string;
  /** Canonical chat/root session whose tabs this acting session drives. */
  browserSessionId?: string;
}

const registry = new Map<string, SessionOwner>();
const aggregatedTaintCounts = new Map<string, number>();
const aggregatedCanarySignatures = new Map<string, string>();

/** Record (or merge into) the owner of a session. Fields left undefined don't
 *  clobber a value set by an earlier call. */
export function registerSessionOwner(sessionId: string, owner: SessionOwner): void {
  const key = sessionId || DEFAULT_BROWSER_SESSION_ID;
  const existing = registry.get(key) ?? {};
  registry.set(key, {
    agentId: owner.agentId ?? existing.agentId,
    browserSessionId: owner.browserSessionId ?? existing.browserSessionId ?? key,
  });
}

/** Register an execution session under its parent chat/agent lineage. The
 * mapping is flattened now so nested descendants remain bound to the root chat
 * after an intermediate agent run has ended. */
export function registerChildSessionOwner(
  sessionId: string,
  parentSessionId: string | undefined,
  owner: Omit<SessionOwner, "browserSessionId"> = {},
): void {
  registerSessionOwner(sessionId, {
    ...owner,
    browserSessionId: parentSessionId
      ? resolveBrowserSessionId(parentSessionId)
      : (sessionId || DEFAULT_BROWSER_SESSION_ID),
  });
}

export function getSessionOwner(sessionId: string): SessionOwner | undefined {
  return registry.get(sessionId || DEFAULT_BROWSER_SESSION_ID);
}

/** Drop a session's owner record. Called when a run ends so a reused session id
 *  can't inherit stale ownership. */
export function clearSessionOwner(sessionId: string): void {
  const key = sessionId || DEFAULT_BROWSER_SESSION_ID;
  registry.delete(key);
  aggregatedTaintCounts.delete(key);
  aggregatedCanarySignatures.delete(key);
}

/**
 * The root browser session an acting session should drive.
 * The registry falls back to the default chat for any session that was
 * never registered (main chat, ad-hoc tool sessions).
 */
/** Canonical owner for browser tabs, caches, locks, views, and downloads. */
export function resolveBrowserSessionId(sessionId: string): string {
  const key = sessionId || DEFAULT_BROWSER_SESSION_ID;
  const registered = getSessionOwner(key)?.browserSessionId;
  if (registered) return registered;
  if (browserContainerRelayActivated()
    && process.env[CONTAINER_BROWSER_ACTING_SESSION] === key) {
    return process.env[CONTAINER_BROWSER_OWNER_SESSION] || key;
  }
  return key;
}

/** Merge an acting child session's security lineage into the chat browser
 * bucket before it can drive that chat's pages. The acting session remains the
 * authority for approvals and tool policy; this aggregate exists solely for
 * page-request egress checks made against the shared browser owner. */
export function aggregateBrowserSessionLineage(sessionId: string): string {
  const actingSessionId = sessionId || DEFAULT_BROWSER_SESSION_ID;
  const browserSessionId = resolveBrowserSessionId(actingSessionId);
  if (actingSessionId === browserSessionId) return browserSessionId;

  const taintCount = getTaintSummary(actingSessionId).count;
  if (taintCount > 0 && aggregatedTaintCounts.get(actingSessionId) !== taintCount) {
    propagateTaint(actingSessionId, browserSessionId);
    aggregatedTaintCounts.set(actingSessionId, taintCount);
  }

  const canaries = getSessionCanaries(actingSessionId);
  const signature = canaries.join("\0");
  if (aggregatedCanarySignatures.get(actingSessionId) !== signature) {
    const merged = [...new Set([...getSessionCanaries(browserSessionId), ...canaries])];
    if (merged.length > 0) registerSessionCanaries(browserSessionId, merged);
    aggregatedCanarySignatures.set(actingSessionId, signature);
  }
  return browserSessionId;
}

/** Test-only: wipe the registry so fixtures don't bleed between cases. */
export function _resetSessionOwnerRegistry(): void {
  registry.clear();
  aggregatedTaintCounts.clear();
  aggregatedCanarySignatures.clear();
}

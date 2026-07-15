/**
 * Session → owner registry.
 *
 * At the browser tool layer the only trusted identity is `args._sessionId`
 * (stamped in tool-execution/resolve-tool.ts). There is no map from a session
 * to the agent that owns it, nor to the browser profile that session should
 * drive. This registry adds exactly that — a small in-memory map populated at
 * the run-prep sites (agent runs in server/handler-events.ts, scheduled runs in
 * background-jobs/cron-runner.ts). Main-chat sessions are left unregistered and
 * resolve to the "default" profile.
 *
 * The three-rung profile precedence (per-run override → per-project roster →
 * agent template default) is resolved UPSTREAM, where the definition, roster,
 * and invoke opts are all in hand (see resolveAgentBrowserProfileId in
 * agents/invoke.ts). By the time a value reaches this registry it is already
 * the winner, so `getBrowserManager` only has to read it back — no store hits
 * on the hot path.
 */

export const DEFAULT_BROWSER_PROFILE_ID = "default";

export interface SessionOwner {
  /** Agent definition id that owns this session, when a spawned agent (not
   *  main chat) drives it. */
  agentId?: string;
  /** Resolved browser profile id for this session (3-rung winner). */
  browserProfileId?: string;
}

const registry = new Map<string, SessionOwner>();

/** Record (or merge into) the owner of a session. Fields left undefined don't
 *  clobber a value set by an earlier call. */
export function registerSessionOwner(sessionId: string, owner: SessionOwner): void {
  const key = sessionId || DEFAULT_BROWSER_PROFILE_ID;
  const existing = registry.get(key) ?? {};
  registry.set(key, {
    agentId: owner.agentId ?? existing.agentId,
    browserProfileId: owner.browserProfileId ?? existing.browserProfileId,
  });
}

export function getSessionOwner(sessionId: string): SessionOwner | undefined {
  return registry.get(sessionId || DEFAULT_BROWSER_PROFILE_ID);
}

/** Drop a session's owner record. Called when a run ends so a reused session id
 *  can't inherit a stale profile. */
export function clearSessionOwner(sessionId: string): void {
  registry.delete(sessionId || DEFAULT_BROWSER_PROFILE_ID);
}

/**
 * The browser profile a session should drive. Reads the pre-resolved value from
 * the registry; falls back to the "default" profile for any session that was
 * never registered (main chat, ad-hoc tool sessions).
 */
export function resolveSessionBrowserProfileId(sessionId: string): string {
  return getSessionOwner(sessionId)?.browserProfileId || DEFAULT_BROWSER_PROFILE_ID;
}

/** Test-only: wipe the registry so fixtures don't bleed between cases. */
export function _resetSessionOwnerRegistry(): void {
  registry.clear();
}

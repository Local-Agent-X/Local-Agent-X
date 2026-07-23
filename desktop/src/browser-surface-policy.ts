// Agent-view surface policy (browser-ipc.ts) — the "visible pane FOLLOWS the
// agent" decision. When the agent's active view changes (a successful agent
// navigate, or an active-tab "show" bridge signal), decide whether the
// renderer's single anchor should FOLLOW the agent (retarget + surface) or just
// BADGE. Split out (like browser-loopback-policy.ts) so the rule is unit-testable
// without dragging in electron, and to keep browser-ipc.ts under its LOC cap.
//
// The rule is STATELESS on purpose. An earlier per-session anchor MAP recorded
// the viewId each session last surfaced and followed when the anchor matched it —
// but adopting a user view recorded a NON-session-scoped id (foreground /
// profile-* / user-N), and a stale such entry cross-matched the anchor and stole
// the user's hand-navigated page (the default foreground included). With no
// stored state there is nothing to go stale: we FOLLOW only when the anchor's
// CURRENT view is an agent view the SURFACING session owns (id `view-<sid>-…`),
// or a blank foreground/profile view (nothing to steal). Everything else — a
// hand-typed foreground page, a user-N tab, an ADOPTED user view, or ANOTHER
// session's agent view — is badged, never stolen.
//
// Tradeoff: after the agent ADOPTS a user tab and then switches back to its own
// tab, the anchor sits on the (non-agent) adopted view, so we BADGE rather than
// follow — the pane stays on the user's own tab until they click. That is the
// safe direction (never steal a user page); the agent's own-tab following, which
// is the reported symptom, is unaffected.

/** The anchor's current view, as decideAgentSurface reads it. */
export interface SurfaceContext {
	/** currentViewId is the user's foreground/profile view (not an agent tab, not a user-N tab). */
	isForegroundFamily: boolean;
	/** currentViewId shows nothing: missing/destroyed webContents, or ""/about:blank. */
	isBlank: boolean;
	/** currentViewId is an agent view OWNED BY THE SURFACING SESSION (id
	 *  `view-<sessionId>-…`). The agent already drives what's shown, so following
	 *  it to that session's new active tab is not a steal. */
	currentIsSessionAgentView: boolean;
}

/**
 * Follow the agent's new active view (true = retarget the anchor + surface) or
 * just badge (false). Follow when the anchor already shows an agent view the
 * SURFACING session owns (its own tab → follow to its new active tab) OR a blank
 * foreground/profile view (nothing to steal). A non-blank foreground page the
 * user typed, a user-N tab, an adopted user view, or another session's view is
 * never this session's agent view → BADGE, never stolen.
 */
export function decideAgentSurface(ctx: SurfaceContext): boolean {
	return ctx.currentIsSessionAgentView || (ctx.isForegroundFamily && ctx.isBlank);
}

/** Is `currentViewId` an in-app agent view OWNED BY `sessionId`? Agent view ids
 *  are minted `view-<sessionId>-<profileId>[-tN]` (instance.ts:166), so a strict
 *  `view-<sessionId>-` prefix identifies exactly this session's own tabs and
 *  excludes foreground / profile-* / user-N and every OTHER session's views. The
 *  trailing hyphen stops a shorter sessionId from prefixing a longer one
 *  (`view-a-` never matches `view-ab-…`). */
export function isSessionAgentView(currentViewId: string, sessionId?: string): boolean {
	return !!sessionId && currentViewId.startsWith(`view-${sessionId}-`);
}

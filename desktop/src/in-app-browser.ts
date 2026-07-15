/**
 * Local Agent X — in-app browser co-drive arbitration + agent cursor.
 *
 * Human-priority lock: the user and the agent share one WebContentsView.
 * Any USER input marks the view user-active for USER_ACTIVE_HOLD_MS; while
 * active the bridge input branch (server-bridge-browser.ts) refuses agent
 * input with { ok:false, userActive:true } instead of dispatching it.
 *
 * Observation hook: "input-event" — it fires for EVERY WebInputEvent the
 * renderer receives (mouse, wheel, key, char), unlike "before-input-event"
 * which is keyboard-only and would leave a user dragging/clicking on an
 * already-focused view invisible. Crucially it also fires for synthetic
 * wc.sendInputEvent traffic, which makes attribution exact 1:1 accounting:
 * markAgentInput() banks ONE token (TTL AGENT_INPUT_ATTRIBUTION_MS) before
 * each agent dispatch; each observed input-event consumes ONE token. Every
 * agent event echoes exactly once — mouse moves, wheel and char included —
 * so counts balance, and any observation with no token left is human. One
 * agent event + one user event inside the same 50ms still arms: two
 * observations, one token. The TTL is only a safety net for a LOST echo
 * (renderer torn down mid-dispatch); arming clears leftover tokens.
 *
 * Arming exception: tokens are consumed on ALL observed types, but a
 * token-less observation only ARMS for deliberate input — hover byproducts
 * (mouseMove / mouseEnter / mouseLeave) never arm. The user's trackpad
 * jiggle while the OS cursor happens to cross the view must not seize the
 * wheel, and an unmatched agent mouseMove echo (lost-token edge) must not
 * arm either.
 *
 * "focus" stays as a belt: a click that transitions focus arms even if its
 * mouse event were somehow missed. Since an agent mouseDown can ALSO pull
 * focus (a second observation for one token), focus never consumes tokens
 * and only arms when NO agent dispatch happened within the attribution TTL.
 *
 * NOT covered here: exec-based interaction. browserExec scripts (JS fills/
 * clicks) bypass input arbitration entirely — A2's backend contract is to
 * consult isUserActive via the input path or a pre-exec guard.
 *
 * Visual cursor: showAgentCursor injects (idempotently, lazily on every
 * call — so it survives navigations) a fixed-position pointer into the
 * page and glides it to the agent's mouse target. Isolated world only —
 * same world id as the exec branch — with a single namespaced variable;
 * nothing touches the main world.
 */

import type { WebContents } from "electron";

/** How long a view stays "user active" after human input. Long enough to
 *  cover a human's think-type-click cadence, short enough that the agent
 *  resumes promptly once the user stops touching the page. */
export const USER_ACTIVE_HOLD_MS = 1500;

/** TTL of one agent-input attribution token. sendInputEvent's "input-event"
 *  echo arrives well under this on any machine; the TTL only matters when an
 *  echo is LOST — longer would widen the window in which such a leaked token
 *  could eat a user event. */
export const AGENT_INPUT_ATTRIBUTION_MS = 50;

/** Must match EXEC_ISOLATED_WORLD_ID in server-bridge-browser.ts — the one
 *  isolated world all agent-injected script runs in (never the main world). */
export const CURSOR_ISOLATED_WORLD_ID = 1901;

/** Cursor glide transition (page-side CSS). */
export const CURSOR_MOVE_TRANSITION_MS = 160;
/** Cursor auto-fade after the last agent action (page-side timer). */
export const CURSOR_FADE_AFTER_MS = 1200;

// ── Pure co-drive state machine (unit-tested via scratch runner) ─────────

export interface CoDriveState {
	/** Human input observed → user-active until this timestamp. */
	userActiveUntil: number;
	/** Outstanding agent attribution tokens (see module doc). */
	agentTokens: number;
	/** All outstanding tokens expire together at this timestamp. */
	agentTokensExpireAt: number;
}

export function createCoDriveState(): CoDriveState {
	return { userActiveUntil: 0, agentTokens: 0, agentTokensExpireAt: 0 };
}

/** Bank one attribution token — call immediately BEFORE each agent
 *  sendInputEvent dispatch. */
export function noteAgentDispatch(state: CoDriveState, now: number): void {
	if (now >= state.agentTokensExpireAt) state.agentTokens = 0; // stale batch
	state.agentTokens += 1;
	state.agentTokensExpireAt = now + AGENT_INPUT_ATTRIBUTION_MS;
}

/** Hover byproducts: consumed as echoes like everything else, but a
 *  token-less one never arms (see module doc "Arming exception"). */
const PASSIVE_INPUT_TYPES = new Set(["mouseMove", "mouseEnter", "mouseLeave"]);

/** An "input-event" observation arrived. Consumes one attribution token if
 *  a live one exists (the agent's own echo — never arms); otherwise arms
 *  the user-active lock unless the type is a hover byproduct. Returns true
 *  iff it armed. */
export function noteObservedInput(state: CoDriveState, now: number, inputType: string): boolean {
	if (state.agentTokens > 0 && now < state.agentTokensExpireAt) {
		state.agentTokens -= 1; // the agent's own echo — do not arm
		return false;
	}
	state.agentTokens = 0;
	if (PASSIVE_INPUT_TYPES.has(inputType)) return false;
	state.userActiveUntil = now + USER_ACTIVE_HOLD_MS;
	return true;
}

/** A "focus" observation arrived (belt for a click whose mouse event was
 *  missed). Never consumes tokens; arms only when no agent dispatch is
 *  recent enough to have pulled focus itself. Returns true iff it armed. */
export function noteFocus(state: CoDriveState, now: number): boolean {
	if (now < state.agentTokensExpireAt) return false; // agent-induced focus
	state.userActiveUntil = now + USER_ACTIVE_HOLD_MS;
	return true;
}

export function isUserActiveAt(state: CoDriveState, now: number): boolean {
	return now < state.userActiveUntil;
}

// ── Per-view wiring ─────────

const coDriveStates = new Map<string, CoDriveState>();

function stateFor(viewId: string): CoDriveState {
	let state = coDriveStates.get(viewId);
	if (!state) {
		state = createCoDriveState();
		coDriveStates.set(viewId, state);
	}
	return state;
}

/** Attach the co-drive hooks to a pooled view's webContents. Called once
 *  per view from browser-views.ts createBrowserView. Never preventDefaults —
 *  human input always passes through; we only observe. */
export function armCoDrive(viewId: string, wc: WebContents): void {
	const state = stateFor(viewId);
	// Fires for every WebInputEvent the renderer receives — user AND
	// synthetic sendInputEvent traffic alike; the token accounting in
	// noteObservedInput tells them apart (see module doc).
	wc.on("input-event", (_event, input) => {
		noteObservedInput(state, Date.now(), input.type ?? "");
	});
	// Belt: the click that transitions focus into the view.
	wc.on("focus", () => {
		noteFocus(state, Date.now());
	});
	wc.once("destroyed", () => {
		coDriveStates.delete(viewId);
	});
}

/** Is the human currently driving this view? */
export function isUserActive(viewId: string): boolean {
	const state = coDriveStates.get(viewId);
	return state ? isUserActiveAt(state, Date.now()) : false;
}

/** Bank an attribution token for an imminent agent input dispatch. */
export function markAgentInput(viewId: string): void {
	noteAgentDispatch(stateFor(viewId), Date.now());
}

// ── Agent cursor overlay ─────────

// Runs in the isolated world: one namespaced variable on that world's
// global (invisible to page JS), a pointer-events:none DOM node re-created
// lazily whenever missing (fresh document after navigation), and a fade
// timer the page script owns. Idempotent per call.
function cursorScript(x: number, y: number): string {
	return `(() => {
	const NS = "__laxAgentCursor1901";
	const g = globalThis;
	let s = g[NS];
	if (!s || !s.el || !document.documentElement.contains(s.el)) {
		const el = document.createElement("div");
		el.setAttribute("data-lax-agent-cursor", "");
		el.style.cssText = "position:fixed;left:0;top:0;width:24px;height:24px;margin:0;padding:0;border:0;" +
			"z-index:2147483647;pointer-events:none;opacity:0;" +
			"transition:transform ${CURSOR_MOVE_TRANSITION_MS}ms ease-out,opacity 200ms ease-out;will-change:transform;";
		el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
			'<path d="M4 2l16 11.5-7.2 1L16 22l-3.4 1.6-3.2-7.4L4 20z" fill="#7c5cff" stroke="#ffffff" stroke-width="1.5"/></svg>';
		document.documentElement.appendChild(el);
		s = g[NS] = { el, timer: 0 };
	}
	s.el.style.transform = "translate(" + ${x} + "px, " + ${y} + "px)";
	s.el.style.opacity = "1";
	clearTimeout(s.timer);
	s.timer = setTimeout(() => { s.el.style.opacity = "0"; }, ${CURSOR_FADE_AFTER_MS});
	return true;
})();`;
}

/** Show/move the visual agent cursor at view-local (x, y). Fire-and-forget:
 *  a cursor that fails to paint (page mid-navigation, about:blank quirks)
 *  must never fail or delay the input dispatch it decorates. */
export function showAgentCursor(wc: WebContents, x: number, y: number): void {
	if (wc.isDestroyed()) return;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return;
	void wc
		.executeJavaScriptInIsolatedWorld(CURSOR_ISOLATED_WORLD_ID, [{ code: cursorScript(x, y) }])
		.catch(() => { /* cosmetic — never surface */ });
}

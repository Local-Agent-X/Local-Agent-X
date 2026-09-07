import type { Page } from "playwright";
import { BrowserManager } from "./manager.js";
import type { BrowserBackend } from "./backend.js";
import { ElectronInAppBackend } from "./in-app-backend.js";
import { sessionIdFromViewId, setAgentViewClosedHandler } from "./bridge-perception.js";
import { resolveBrowserSessionId } from "./session-owner-registry.js";
import { closeSharedBrowser, forceKillSharedBrowser } from "./runtime.js";
import { clearAllSessionEmulation, clearSessionEmulation, getSessionEmulation } from "./emulation.js";
import {
	forgetAllReportedRoutes,
	forgetReportedRoute,
	inAppBackendAvailable,
	reportBrowserRoute,
	resolveBrowserRoute,
	routeForSession,
} from "./route-resolve.js";
import { getRuntimeConfig } from "../config.js";
import { createCdpSecretOps, type SecretBrowserOps } from "./secret-ops.js";
import { WindowsChatChromeRuntime } from "./windows-chat-chrome-runtime.js";

// The routing decision itself lives in route-resolve.ts; re-exported here
// because instance.js is the import site every caller and test already uses.
export {
	resolveBrowserRoute,
	resolveBrowserBackendKind,
	_setBrowserRoutePlatformForTest,
	type BrowserRoute,
	type BrowserRouteReason,
	type BrowserBackendKind,
} from "./route-resolve.js";

// One backend per session — THE routing seam for the browser tool. Two kinds:
//   - BrowserManager (CDP): one external Chrome process, one manager per
//     session. Each manager owns its own tabs + observation registry
//     (see manager.ts), so concurrent sessions — e.g. a chat and a scheduled
//     mission — never stomp each other's page or refs.
//   - ElectronInAppBackend: an embedded desktop WebContentsView per
//     (session, profile), driven over the B1 bridge.
// Identity ownership is selected explicitly by browserMode.
const cdpManagers = new Map<string, BrowserManager>();
const inAppBackends = new Map<string, { backend: ElectronInAppBackend; viewId: string }>();

/**
 * Keys whose cdpManagers entry was minted UNDER the emulation route — i.e. the
 * private quarantined context standing in for an in-app view, not a browser the
 * user has tabs in.
 *
 * This distinction is load-bearing: `cdpManagers` holds both kinds under the
 * same key, so "close the emulated context" and "close the session's real
 * external Chrome" were indistinguishable, and releaseEmulatedBrowser closed
 * whichever it found. A session that fell back to CDP while the desktop bridge
 * was down holds a REAL browser with real tabs at that key.
 */
const emulatedCdpKeys = new Set<string>();

/** Does this session hold a CDP browser that is NOT the emulated stand-in — a
 *  real external Chrome with the user's tabs in it? Read by the `emulate` tool,
 *  which must not stand an emulated context up on top of one. */
export function hasNonEmulatedCdpBrowser(sessionId: string = "default"): boolean {
	const key = resolveBrowserSessionId(sessionId || "default");
	return cdpManagers.has(key) && !emulatedCdpKeys.has(key);
}

// User ✕ on an agent pill (desktop push, via bridge-client): tell the owning
// backend its view is gone so the next op recreates it instead of wedging on
// a dead viewId. Unknown session / no backend → nothing to mark.
setAgentViewClosedHandler((viewId) => {
	const sessionId = sessionIdFromViewId(viewId);
	if (sessionId === undefined) return;
	inAppBackends.get(sessionId)?.backend.noteViewClosedExternally(viewId);
});

/** getCdpBrowserManager was called for a session routed to the in-app backend.
 *  Handing back a CDP manager there would open a second, separate browser
 *  identity beside the session's live view. */
export class CdpOnlyOperationError extends Error {
	constructor(sessionId: string) {
		super(
			`This session's browser runs on the in-app backend (sessionId=${sessionId}), ` +
				`which has no Playwright page. Use getSecretBrowserOps for page access ` +
				`that works on both backends.`,
		);
		this.name = "CdpOnlyOperationError";
	}
}

/** Deterministic first-tab id for one chat-owned embedded browser session. */
export function inAppViewId(sessionId: string): string {
	return `view-${sessionId}-shared`;
}

/** Does this session currently own a live in-app browser backend? Read by the
 *  pre-dispatch screen-capture redirect gate. Cheap map lookup, no lifecycle
 *  ping — same reasoning as getBrowserManager: a dead view fails loudly at
 *  first use, so this seam never guesses ahead of time.
 *
 *  LIMIT: this answers "is there a view", NOT "is that view what the browser
 *  tool reads". While a session emulates, the entry is deliberately still here
 *  (emulation-route.ts) but page actions run on the private emulated context,
 *  so a caller that uses this to tell the agent "screenshot the browser pane"
 *  is naming a pane the screenshot will not show. */
export function hasInAppBackend(sessionId: string = "default"): boolean {
	return inAppBackends.has(resolveBrowserSessionId(sessionId || "default"));
}

function peerPagesExcept(self: BrowserManager): Page[] {
	const pages: Page[] = [];
	for (const m of cdpManagers.values()) {
		if (m !== self) pages.push(...m.listOwnedPages());
	}
	return pages;
}

function ensureCdpManager(key: string, dedicatedWindowsChrome = false): BrowserManager {
	let manager = cdpManagers.get(key);
	if (!manager) {
		// Resolve the chat-scoped browser session and
		// run-prep) and bind the manager to it. CDP behavior is unchanged — the
		// use the shared persistent identity.
		const runtime = dedicatedWindowsChrome ? new WindowsChatChromeRuntime(key) : undefined;
		manager = new BrowserManager(key, getRuntimeConfig().browserMode, runtime);
		manager.setPeerPages(() => peerPagesExcept(manager!));
		manager.setIdleHandler(() => {
			if (cdpManagers.get(key) === manager) {
				cdpManagers.delete(key);
				emulatedCdpKeys.delete(key);
			}
			if (cdpManagers.size === 0) void closeSharedBrowser();
		});
		cdpManagers.set(key, manager);
		// Minted while a profile is installed → this IS the emulated stand-in.
		// Recorded at mint time because the profile can be cleared before the
		// context is dropped (emulate device='desktop' does exactly that).
		if (getSessionEmulation(key)) emulatedCdpKeys.add(key);
	}
	return manager;
}

function ensureInAppBackend(key: string): ElectronInAppBackend {
	let entry = inAppBackends.get(key);
	if (!entry) {
		const viewId = inAppViewId(key);
		entry = { backend: new ElectronInAppBackend(key, viewId), viewId };
		// No idle handler for in-app backends (unlike the CDP path): views are
		// cheap, pool-owned on the desktop side, and hold no Chrome process of
		// their own — there is no shared browser to tear down when idle. They
		// close on session close only (closeBrowser/closeAllBrowsers).
		inAppBackends.set(key, entry);
	}
	return entry.backend;
}

// Returns BrowserBackend — the tool-facing contract. Routes to the embedded
// in-app view when the mode + environment select it, and to the CDP
// BrowserManager otherwise. Callers depend on the interface, not the class.
export function getBrowserManager(sessionId: string = "default"): BrowserBackend {
	const key = resolveBrowserSessionId(sessionId || "default");
	// The CDP manager is bound to the chat-scoped browser session, while its
	// userDataDir is threaded into launchViaCDP at first getPage() — so every
	// arms share the same persistent login identity.
	const route = routeForSession(key);
	reportBrowserRoute(key, route);
	if (route.kind === "in-app") return ensureInAppBackend(key);
	return ensureCdpManager(key, route.reason === "windows-chat-chrome");
}

/**
 * Page access for the secret tools, on whichever backend the session actually
 * has. This is the seam that used to force secret-fill/secret-capture onto CDP:
 * they took a BrowserManager and drove its Playwright page, so a session on the
 * in-app backend — the default — got a typed refusal and no saved-password
 * logins at all. Both backends can do what those tools need; only the concrete
 * page handle differed, which is what SecretBrowserOps abstracts.
 */
export function getSecretBrowserOps(sessionId: string = "default"): SecretBrowserOps {
	const key = resolveBrowserSessionId(sessionId || "default");
	// Same override as getBrowserManager (routeForSession, NOT the raw route):
	// while emulating, the session's live page IS the emulated one, so a secret
	// fill must land there and NOT in the user's real logged-in view.
	const route = routeForSession(key);
	reportBrowserRoute(key, route);
	if (route.kind === "in-app") return ensureInAppBackend(key).secretOps();
	const manager = ensureCdpManager(key, route.reason === "windows-chat-chrome");
	return createCdpSecretOps(() => manager.getPage());
}

/**
 * Concrete-typed accessor for CDP-internal helpers that need the Playwright
 * `Page`. Not part of the tool-facing BrowserBackend contract — the in-app
 * backend has no Playwright page, so a session routed in-app gets a typed
 * refusal instead of a surprise second (CDP) browser identity opening beside
 * its view.
 */
export function getCdpBrowserManager(sessionId: string = "default"): BrowserManager {
	const key = resolveBrowserSessionId(sessionId || "default");
	// The emulation override (emulation-route.ts) is the ONE case where an in-app
	// session legitimately holds a CDP manager: the private emulated context
	// standing in for the view the user is looking at.
	if (!getSessionEmulation(key) && (inAppBackends.has(key) || inAppBackendAvailable())) {
		throw new CdpOnlyOperationError(key);
	}
	return ensureCdpManager(key, resolveBrowserRoute().reason === "windows-chat-chrome");
}

/** Close the private emulated CDP context of a session whose real browser is
 *  the in-app view — the way back, and the re-mint step when `emulate` runs a
 *  second time. Leaves inAppBackends alone: the user's view, tabs and page
 *  survive untouched.
 *
 *  PRECONDITION, now CHECKED rather than asserted: this closes the key's CDP
 *  manager ONLY if that manager was minted under the emulation route. A session
 *  that fell back to real external Chrome (bridge down) holds a browser with the
 *  user's tabs at the same key, and this used to close it and report success.
 *
 *  Set/clear the profile FIRST; this only drops the context, and the next page
 *  access re-mints from whatever the profile then says (ordering pinned by
 *  emulate-in-app-hazards.test.ts). */
export async function releaseEmulatedBrowser(sessionId: string = "default"): Promise<void> {
	const key = resolveBrowserSessionId(sessionId || "default");
	if (!emulatedCdpKeys.has(key)) return;
	forgetReportedRoute(key);
	emulatedCdpKeys.delete(key);
	const manager = cdpManagers.get(key);
	if (!manager) return;
	cdpManagers.delete(key);
	await manager.close();
	if (cdpManagers.size === 0) await closeSharedBrowser();
}

export async function closeBrowser(sessionId: string = "default"): Promise<void> {
	const key = resolveBrowserSessionId(sessionId || "default");
	forgetReportedRoute(key);
	// Device emulation dies with the session: a reused session id must never
	// inherit the previous session's phone viewport / spoofed user agent.
	clearSessionEmulation(key);
	emulatedCdpKeys.delete(key);
	// A session can (rarely) have entries of both kinds — e.g. the mode flipped
	// mid-session. Close whichever exist.
	const inApp = inAppBackends.get(key);
	if (inApp) {
		inAppBackends.delete(key);
		await inApp.backend.close();
	}
	const manager = cdpManagers.get(key);
	if (manager) {
		cdpManagers.delete(key);
		await manager.close();
	}
	if (cdpManagers.size === 0) await closeSharedBrowser();
}

/** How resetWedgedBrowser resolved a wedge — drives what the tool layer tells
 *  the agent (browser-tools wedgeRecoveryMessage). */
export type WedgeRecoveryOutcome =
	/** In-app view answered a liveness ping: same backend, same view, same URL —
	 *  only observation state was reset. The agent just retries. */
	| "recovered-in-place"
	/** In-app view was dead: owned views dropped, backend kept, and the active
	 *  tab's URL preserved so the recreated view re-navigates to it. */
	| "view-recreated"
	/** CDP arm: shared Chrome force-killed; the next call launches a fresh one. */
	| "cdp-reset";

/**
 * In-process wedge recovery (no LAX restart). When a browser action hangs and
 * its deadline fires, recover the offending session's backend.
 *
 * WHICH backend is the same question getBrowserManager answers — routeForSession,
 * not the raw map. While a profile is installed the session's page actions run
 * on the private emulated CDP context, so THAT is what wedged; the in-app entry
 * is deliberately still in the map (emulation-route.ts). Branching on the map
 * first aborted the user's in-flight load and closed every tab they own, and
 * left the actual wedge unrecovered.
 *
 * In-app: SOFT first — abort the active view's in-flight load and ping it
 * (bounded by LIFECYCLE_TIMEOUT_MS). A live view keeps its backend, view and
 * URL, so a 10s page-scan wedge no longer costs the tab and every ref on it.
 * Only a dead ping falls back to teardown (fire-and-forget closes — awaiting
 * a wedged bridge can hang) — and even then the backend stays in the map with
 * the active tab's URL preserved, so the next action's ensureView recreates
 * the view AND re-navigates instead of landing on about:blank.
 *
 * CDP: force-kill the shared Chrome. Every session's cached page now points
 * at a dead connection, so the next browser call re-launches a fresh Chrome
 * and rebuilds its tabs (BrowserManager.getPage's liveness check catches the
 * dead page and re-acquires). Synchronous + force: we must NOT await graceful
 * teardown on a wedged connection — that can hang too.
 */
export async function resetWedgedBrowser(sessionId: string = "default"): Promise<WedgeRecoveryOutcome> {
	const key = resolveBrowserSessionId(sessionId || "default");
	const emulating = getSessionEmulation(key) !== undefined;
	const inApp = emulating ? undefined : inAppBackends.get(key);
	if (inApp) {
		if (await inApp.backend.recoverFromWedge()) {
			// Same backend, same view — the session's route did not change.
			return "recovered-in-place";
		}
		forgetReportedRoute(key);
		return "view-recreated";
	}
	forgetReportedRoute(key);
	const manager = cdpManagers.get(key);
	cdpManagers.delete(key);
	emulatedCdpKeys.delete(key);
	if (manager) await manager.resetRuntime();
	else forceKillSharedBrowser();
	return "cdp-reset";
}

export async function closeAllBrowsers(): Promise<void> {
	const all: BrowserBackend[] = [
		...[...inAppBackends.values()].map((e) => e.backend),
		...cdpManagers.values(),
	];
	inAppBackends.clear();
	cdpManagers.clear();
	emulatedCdpKeys.clear();
	forgetAllReportedRoutes();
	// Every backend just went away, so no session can still be "on" an emulated
	// context. Leaving the profiles behind stranded the next use of those session
	// ids on a headless phone viewport with no window to see (F3).
	clearAllSessionEmulation();
	let teardownError: unknown;
	for (const b of all) {
		try { await b.close(); } catch (error) { teardownError ??= error; }
	}
	try { await closeSharedBrowser(); } catch (error) { teardownError ??= error; }
	if (teardownError) throw teardownError;
}

// Backwards compat — session ID now passed directly to getBrowserManager.
export function setCurrentBrowserSession(_sessionId: string): void {}

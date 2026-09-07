/**
 * THE browser routing decision — which backend a session gets, WHY, and the
 * once-per-answer report of it. Split out of instance.ts (which sat exactly on
 * the 400-LOC gate) along the seam the emulation override created: this module
 * decides the route, instance.ts owns the backend maps and their lifecycle.
 *
 * Nothing here mints, opens or closes anything: every function is a pure read
 * of config + env + the session's emulation profile, plus one logger line.
 */

import type { BrowserMode } from "../types.js";
import { getRuntimeConfig } from "../config.js";
import { desktopBridgeAvailable } from "../desktop-bridge.js";
import { createLogger } from "../logger.js";
import { applyEmulationRoute, emulationRouteLine } from "./emulation-route.js";

const logger = createLogger("browser.route");

/**
 * Does this browserMode select the in-app backend? The "in-app" enum value is
 * now the default (chunk F2 added it to BrowserMode + made it the fresh-config
 * default), so this predicate is live in production: a windowed desktop run
 * routes to the embedded WebContentsView, and everything else falls back to
 * CDP (see resolveBrowserBackendKind).
 */
function wantsInAppBackend(mode: BrowserMode): boolean {
	return mode === "in-app";
}

export type BrowserBackendKind = "in-app" | "cdp";

/**
 * WHY a session landed on its backend. The kind alone can't be reported
 * usefully: "cdp" collapses a deliberate config choice, an expected headless
 * run, and a genuine failure to reach the desktop app into one indistinguishable
 * bit. Each arm wants a different severity and a different thing said to the
 * user, so the reason is the return value and the kind is derived from it.
 */
export type BrowserRouteReason =
	/** Every condition held — the embedded WebContentsView. */
	| "in-app"
	/** Config selects external Chrome. A choice being honored, not a fallback. */
	| "mode-not-in-app"
	/** LAX_BROWSER_HEADLESS=1 — CI/soak, no desktop window to mount a view in. */
	| "headless"
	/** Windows uses installed Chrome because Electron is rejected by common human checks. */
	| "windows-chat-chrome"
	/** Wanted in-app but the desktop app/bridge isn't there. The surprising arm. */
	| "no-desktop-bridge"
	/** In-app session with a device-emulation profile installed: page actions run
	 *  in a private quarantined CDP context (see emulation-route.ts). */
	| "emulation";

export interface BrowserRoute {
	kind: BrowserBackendKind;
	reason: BrowserRouteReason;
}

let routePlatformOverride: NodeJS.Platform | null = null;

export function _setBrowserRoutePlatformForTest(platform: NodeJS.Platform | null): void {
	routePlatformOverride = platform;
}

/**
 * THE fallback matrix — one source of truth for both the routing decision and
 * the reason reported for it. A session resolves to the embedded in-app
 * WebContentsView ONLY when all three conditions hold; it falls to the CDP
 * BrowserManager (which carries the profile's own userDataDir, so the fallback
 * keeps the profile's logins) on the first condition that fails.
 *
 * Order is deliberate: an explicit non-in-app browserMode outranks the
 * environment checks, so a user who picked external Chrome is told THAT, not
 * that some bridge was missing.
 *
 * All synchronous — NO live lifecycle ping: getBrowserManager is sync and on the
 * tool hot path. A ping-based mounted-view check was considered and rejected:
 * the backend's view create is lazy and fails loudly (bridge-client rejects
 * typed errors), so the tool layer surfaces a dead bridge at first use instead
 * of this seam guessing ahead of time.
 *
 * This is the RAW route — it does not know about the emulation override. Use
 * routeForSession when you need the route a specific session actually gets.
 */
export function resolveBrowserRoute(platform: NodeJS.Platform = routePlatformOverride ?? process.platform): BrowserRoute {
	if (!wantsInAppBackend(getRuntimeConfig().browserMode)) {
		return { kind: "cdp", reason: "mode-not-in-app" };
	}
	if (process.env.LAX_BROWSER_HEADLESS === "1") {
		return { kind: "cdp", reason: "headless" };
	}
	// Windows once forced external Chrome here because "Electron is rejected by
	// common human checks" — but that rejection was the app.userAgentFallback UA
	// drift (a spoofed <App>/<ver> token contradicting the page identity), fixed in
	// embedded-chrome-identity. A UA-consistent embedded browser clears Cloudflare
	// on every platform, so Windows now takes the SAME in-app route as macOS/Linux.
	if (!desktopBridgeAvailable()) {
		return { kind: "cdp", reason: "no-desktop-bridge" };
	}
	return { kind: "in-app", reason: "in-app" };
}

export function resolveBrowserBackendKind(): BrowserBackendKind {
	return resolveBrowserRoute().kind;
}

export function inAppBackendAvailable(): boolean {
	return resolveBrowserRoute().kind === "in-app";
}

/** The session's route with the emulation override applied — see
 *  emulation-route.ts for why an in-app session can be sent to a CDP context. */
export function routeForSession(key: string): BrowserRoute {
	return applyEmulationRoute(resolveBrowserRoute(), key);
}

/** Reason last reported per session, so a steady state stays quiet. */
const routeReported = new Map<string, BrowserRouteReason>();

/** Forget one session's last-reported reason, so the next route resolution
 *  speaks again. Called by instance.ts wherever a session's backend changes. */
export function forgetReportedRoute(key: string): void {
	routeReported.delete(key);
}

export function forgetAllReportedRoutes(): void {
	routeReported.clear();
}

/**
 * Say which browser a session got, and why, ONCE — and again only when the
 * answer changes (a mid-session mode flip, or the desktop bridge dropping).
 * getBrowserManager is on the tool hot path, so this must never emit per call.
 *
 * Before this, every arm of the matrix was silent: a session that asked for the
 * in-app browser and got external Chrome said nothing anywhere, and the only
 * signal a user ever got was noticing a Chrome window appear on their desktop.
 */
export function reportBrowserRoute(sessionId: string, route: BrowserRoute): void {
	if (routeReported.get(sessionId) === route.reason) return;
	routeReported.set(sessionId, route.reason);
	const who = `(sessionId=${sessionId})`;
	switch (route.reason) {
		case "in-app":
			logger.debug(`[browser-route] embedded in-app browser ${who}`);
			return;
		case "mode-not-in-app":
			logger.info(
				`[browser-route] external Chrome ${who} — browserMode="${getRuntimeConfig().browserMode}" ` +
					`selects it. Set browserMode="in-app" for the embedded co-drivable browser.`,
			);
			return;
		case "headless":
			logger.info(
				`[browser-route] external Chrome ${who} — LAX_BROWSER_HEADLESS=1, no desktop window to mount a view in.`,
			);
			return;
		case "windows-chat-chrome":
			logger.info(`[browser-route] dedicated chat-scoped Chrome ${who} — Windows in-app compatibility route.`);
			return;
		case "emulation":
			logger.info(emulationRouteLine(who));
			return;
		case "no-desktop-bridge":
			logger.warn(
				`[browser-route] external Chrome ${who} — browserMode="in-app" wants the embedded browser, ` +
					`but the desktop bridge is unavailable (not running under the desktop app?). Falling back to CDP.`,
			);
			return;
	}
}

import type { Page } from "playwright";
import { BrowserManager } from "./manager.js";
import type { BrowserBackend } from "./backend.js";
import type { BrowserMode } from "../types.js";
import { ElectronInAppBackend } from "./in-app-backend.js";
import { browserAbort } from "./bridge-client.js";
import { resolveSessionBrowserProfileId } from "./session-owner-registry.js";
import { closeSharedBrowser, forceKillSharedBrowser } from "./runtime.js";
import { desktopBridgeAvailable } from "../desktop-bridge.js";
import { getRuntimeConfig } from "../config.js";

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

/** getCdpBrowserManager was called for a session routed to the in-app
 *  backend. Secret handling stays CDP-only for now (parked product decision). */
export class CdpOnlyOperationError extends Error {
	constructor(sessionId: string) {
		super(
			`This session's browser runs on the in-app backend (sessionId=${sessionId}), ` +
				`but secret-fill/secret-capture require the CDP profile flow for now — ` +
				`that's the parked product decision. Switch the session off the in-app ` +
				`browser mode to use secret handling.`,
		);
		this.name = "CdpOnlyOperationError";
	}
}

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

/**
 * Availability = mode + env + bridge presence, all synchronous — NO live
 * lifecycle ping here: getBrowserManager is sync and on the tool hot path.
 * A ping-based mounted-view check was considered and rejected: the backend's
 * view create is lazy and fails loudly (bridge-client rejects typed errors),
 * so the tool layer surfaces a dead bridge at first use instead of this seam
 * guessing ahead of time. Headless runs (LAX_BROWSER_HEADLESS=1 — CI, soak)
 * have no desktop window to mount a view in, so they stay on CDP.
 */
function inAppBackendAvailable(): boolean {
	return (
		wantsInAppBackend(getRuntimeConfig().browserMode) &&
		process.env.LAX_BROWSER_HEADLESS !== "1" &&
		desktopBridgeAvailable()
	);
}

export type BrowserBackendKind = "in-app" | "cdp";

/**
 * THE fallback matrix, made explicit + testable. A session resolves to the
 * embedded in-app WebContentsView ONLY when all three conditions hold; it falls
 * to the CDP BrowserManager (which now carries the profile's own userDataDir, so
 * the fallback keeps the profile's logins) when ANY of these is true:
 *
 *   condition                         → backend
 *   ─────────────────────────────────────────────
 *   browserMode !== "in-app"          → cdp   (config selects external Chrome)
 *   LAX_BROWSER_HEADLESS=1            → cdp   (no desktop window to mount a view)
 *   !desktopBridgeAvailable()         → cdp   (no desktop app / bridge down)
 *   all of: in-app + windowed + bridge → in-app
 *
 * This is just the sign of inAppBackendAvailable(), named so the routing intent
 * is legible and the ELSE branch (which must supply the profile's userDataDir)
 * is a first-class, tested outcome rather than an implicit fallthrough.
 */
export function resolveBrowserBackendKind(): BrowserBackendKind {
	return inAppBackendAvailable() ? "in-app" : "cdp";
}

/** Deterministic view id — one embedded view per (session, profile), so a
 *  re-created backend for the same pair adopts the same desktop view. */
export function inAppViewId(sessionId: string, profileId: string): string {
	return `view-${sessionId}-${profileId}`;
}

function peerPagesExcept(self: BrowserManager): Page[] {
	const pages: Page[] = [];
	for (const m of cdpManagers.values()) {
		if (m !== self) pages.push(...m.listOwnedPages());
	}
	return pages;
}

function ensureCdpManager(key: string): BrowserManager {
	let manager = cdpManagers.get(key);
	if (!manager) {
		// Resolve the session's browser profile (3-rung winner, pre-computed at
		// run-prep) and bind the manager to it. CDP behavior is unchanged — the
		// profile is carried for the in-app backend + CDP userDataDir twin later.
		const profileId = resolveSessionBrowserProfileId(key);
		manager = new BrowserManager(key, getRuntimeConfig().browserMode, profileId);
		manager.setPeerPages(() => peerPagesExcept(manager!));
		manager.setIdleHandler(() => {
			if (cdpManagers.get(key) === manager) cdpManagers.delete(key);
			if (cdpManagers.size === 0) void closeSharedBrowser();
		});
		cdpManagers.set(key, manager);
	}
	return manager;
}

function ensureInAppBackend(key: string): ElectronInAppBackend {
	let entry = inAppBackends.get(key);
	if (!entry) {
		const profileId = resolveSessionBrowserProfileId(key);
		const viewId = inAppViewId(key, profileId);
		entry = { backend: new ElectronInAppBackend(key, profileId, viewId), viewId };
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
	const key = sessionId || "default";
	// The CDP manager it returns is bound to the session's profile id, whose
	// userDataDir is threaded into launchViaCDP at first getPage() — so every
	// arm of this matrix carries the right profile identity.
	if (resolveBrowserBackendKind() === "in-app") return ensureInAppBackend(key);
	return ensureCdpManager(key);
}

/**
 * Concrete-typed accessor for CDP-internal helpers that need the Playwright
 * `Page` (secret-fill / secret-capture operate directly on the page). Not part
 * of the tool-facing BrowserBackend contract — the in-app backend has no
 * Playwright page, so a session routed in-app gets a typed refusal instead of
 * a surprise second (CDP) browser identity opening beside its view.
 */
export function getCdpBrowserManager(sessionId: string = "default"): BrowserManager {
	const key = sessionId || "default";
	if (inAppBackends.has(key) || inAppBackendAvailable()) {
		throw new CdpOnlyOperationError(key);
	}
	return ensureCdpManager(key);
}

export async function closeBrowser(sessionId: string = "default"): Promise<void> {
	const key = sessionId || "default";
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

/**
 * In-process wedge recovery (no LAX restart). When a browser action hangs and
 * its deadline fires, drop the offending session's backend.
 *
 * In-app: abort the view's in-flight load (fire-and-forget) and close the
 * view; only this session's view dies — no shared process to kill. close()
 * is fire-and-forget too: awaiting a wedged bridge can hang, and
 * bridge-client's close rejects the view's other pending ops immediately.
 *
 * CDP: force-kill the shared Chrome. Every session's cached page now points
 * at a dead connection, so the next browser call re-launches a fresh Chrome
 * and rebuilds its tabs (BrowserManager.getPage's liveness check catches the
 * dead page and re-acquires). Synchronous + force: we must NOT await graceful
 * teardown on a wedged connection — that can hang too.
 */
export function resetWedgedBrowser(sessionId: string = "default"): void {
	const key = sessionId || "default";
	const inApp = inAppBackends.get(key);
	if (inApp) {
		inAppBackends.delete(key);
		browserAbort(inApp.viewId);
		void inApp.backend.close().catch(() => {});
		return;
	}
	cdpManagers.delete(key);
	forceKillSharedBrowser();
}

export async function closeAllBrowsers(): Promise<void> {
	const all: BrowserBackend[] = [
		...[...inAppBackends.values()].map((e) => e.backend),
		...cdpManagers.values(),
	];
	inAppBackends.clear();
	cdpManagers.clear();
	let teardownError: unknown;
	for (const b of all) {
		try { await b.close(); } catch (error) { teardownError ??= error; }
	}
	try { await closeSharedBrowser(); } catch (error) { teardownError ??= error; }
	if (teardownError) throw teardownError;
}

// Backwards compat — session ID now passed directly to getBrowserManager.
export function setCurrentBrowserSession(_sessionId: string): void {}

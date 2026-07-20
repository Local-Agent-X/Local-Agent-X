/**
 * In-app navigation settle logic — extracted from server-bridge-browser.ts
 * so the wait semantics are unit-testable against a fake webContents.
 *
 * Settle rules (the 2026-07-20 wedge class): full quiescence
 * (did-finish-load / did-stop-loading) is the WRONG success signal for a
 * heavy CSR SPA — pages like cloud.thrivemetrics.com stream XHRs for minutes
 * and never quiesce, so the old wait outran the 25s desktop deadline AND the
 * server's 29s wedge timer, force-resetting a session that was actually
 * fine. The document being interactive is the real bar the agent needs
 * (its observe/snapshot walk the live DOM regardless of pending
 * subresources), so:
 *
 *   1. did-finish-load / did-stop-loading still settle immediately — fast
 *      pages behave byte-identically to before.
 *   2. dom-ready arms a short grace timer (INTERACTIVE_SETTLE_MS): if full
 *      load lands within it, settle as before; otherwise settle ok with
 *      `interactive: true` and let the page keep loading in the background.
 *   3. The hard deadline remains the backstop for pages that never even
 *      reach dom-ready — only THAT path stops the load.
 *
 * All success/interactive/dom-ready signals are gated on this navigation
 * having actually STARTED (did-start-loading after our loadURL): since an
 * interactive settle now leaves loads in flight on purpose, a stale
 * did-stop-loading from the previous page must not settle the next
 * navigate with the old URL.
 */

export const INTERACTIVE_SETTLE_MS = 3_000;

/** The slice of Electron.WebContents the settle logic needs — narrow on
 *  purpose so tests can drive it with a plain emitter-backed fake. Listener
 *  params are unknown[] (not never[]): method-position bivariance makes both
 *  work against Electron's typings, but never[] fails against EventEmitter
 *  fakes under some @types/node versions (seen on the installed app's
 *  reconcile compile, 2026-07-20). */
export interface NavigableWebContents {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	off(event: string, listener: (...args: unknown[]) => void): unknown;
	loadURL(url: string): Promise<unknown>;
	getURL(): string;
	getTitle(): string;
	stop(): void;
	isDestroyed(): boolean;
}

export interface NavigateSettleOptions {
	timeoutMs: number;
	/** Grace between dom-ready and the interactive settle. Overridable in tests. */
	interactiveSettleMs?: number;
	/** Fired once on any successful settle (full or interactive). */
	onSuccess?: () => void;
	/** Hook fired right after listeners attach, before loadURL — the caller's
	 *  "this is an agent navigation" bookkeeping (markAgentNavigation). */
	onBeforeLoad?: () => void;
}

export function settleNavigation(
	wc: NavigableWebContents,
	url: string,
	opts: NavigateSettleOptions,
): Promise<Record<string, unknown>> {
	const graceMs = opts.interactiveSettleMs ?? INTERACTIVE_SETTLE_MS;
	return new Promise((resolve) => {
		let settled = false;
		let navStarted = false;
		let interactiveTimer: ReturnType<typeof setTimeout> | undefined;
		// Main-frame HTTP status: 'did-navigate' carries httpResponseCode, so an
		// HTTP ≥400 error page (which still load-finishes) is finally detectable
		// by the server side. Absent for non-HTTP loads → the client keeps its
		// "unknown" fallback.
		let status: number | undefined;
		const finish = (payload: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			if (interactiveTimer) clearTimeout(interactiveTimer);
			wc.off("did-start-loading", onStart);
			wc.off("did-fail-load", onFail);
			wc.off("did-finish-load", onDone);
			wc.off("did-stop-loading", onDone);
			wc.off("did-navigate", onNavigated);
			wc.off("dom-ready", onDomReady);
			resolve(payload);
		};
		const succeed = (extra: Record<string, unknown> = {}) => {
			finish({ ok: true, url: wc.getURL(), title: wc.getTitle(), ...(status !== undefined ? { status } : {}), ...extra });
			opts.onSuccess?.();
		};
		const onStart = () => { navStarted = true; };
		// Electron event args arrive as unknown[] through the narrowed interface;
		// destructure + assert inside so the listener type stays fake-compatible.
		const onFail = (...args: unknown[]) => {
			const [, errorCode, errorDescription, validatedURL, isMainFrame] =
				args as [unknown, number, string, string, boolean];
			if (!isMainFrame || errorCode === -3) return;
			finish({ ok: false, error: `${errorDescription || `load failed (${errorCode})`} (${validatedURL})` });
		};
		const onNavigated = (...args: unknown[]) => {
			const httpResponseCode = args[2];
			if (typeof httpResponseCode === "number" && httpResponseCode > 0) status = httpResponseCode;
		};
		const onDone = () => {
			if (settled || !navStarted) return;
			succeed();
		};
		const onDomReady = () => {
			if (settled || !navStarted || interactiveTimer) return;
			interactiveTimer = setTimeout(() => {
				if (settled) return;
				// Document interactive but never quiesced — settle WITHOUT stopping
				// the load; the SPA keeps streaming in the background.
				succeed({ interactive: true });
			}, graceMs);
		};
		const deadline = setTimeout(() => {
			// Stop the still-loading page — the client has already given up,
			// and a zombie load would race the NEXT navigate's did-stop-loading.
			if (!wc.isDestroyed()) wc.stop();
			finish({ ok: false, error: `navigation did not settle within ${opts.timeoutMs}ms` });
		}, opts.timeoutMs);
		wc.on("did-start-loading", onStart);
		wc.on("did-fail-load", onFail);
		wc.on("did-finish-load", onDone);
		wc.on("did-stop-loading", onDone);
		wc.on("did-navigate", onNavigated);
		wc.on("dom-ready", onDomReady);
		opts.onBeforeLoad?.();
		wc.loadURL(url).catch((e: unknown) => {
			finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
		});
	});
}

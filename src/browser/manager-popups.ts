/**
 * Site-opened popup adoption for the CDP BrowserManager — split out of
 * manager.ts to keep it under the 400-LOC ceiling. A page a site opens
 * (window.open / target=_blank) must be adopted into the manager's owned pages
 * or it is stranded off the tab list and switch_tab can't reach it, pinning the
 * agent on the opener.
 */
import type { BrowserContext, Page } from "playwright";

/** Live accessors into a BrowserManager's page-ownership state. Accessors, not a
 *  captured `owned` array — the manager REASSIGNS `this.owned` on tab cleanup, so
 *  a captured reference would go stale. */
export interface PopupHost {
	/** Per-manager set of already-wired contexts (idempotent subscribe). MUST be
	 *  per manager: shared mode hands every session the same context and each
	 *  manager opener-gates independently — a module-level set would let only the
	 *  first manager wire it and the rest would miss their own popups. */
	wired: WeakSet<BrowserContext>;
	isOwned(p: Page): boolean;
	addOwned(p: Page): void;
	peers(): Page[];
	adopt(p: Page): Page;
}

/** Subscribe once per context to its "page" event so a site-opened page is
 *  adopted. Idempotent per context (the WeakSet): getPage() re-acquires whenever
 *  its page dies, so a naive subscribe would stack handlers. */
export function wirePopupAdoption(ctx: BrowserContext, host: PopupHost): void {
	if (host.wired.has(ctx)) return;
	host.wired.add(ctx);
	ctx.on("page", (p) => { void adoptOpenedPage(host, p); });
}

/** Adopt a site-opened page IFF one of the host's tabs opened it. opener() is
 *  the ownership signal that preserves advanced-shared isolation: a page a peer
 *  session's tab opened has an opener the host doesn't own → never adopted (no
 *  cross-session leak). Pages the manager opens (acquirePage/newTab) have a null
 *  opener and are pushed to owned explicitly → skipped here (no double-adopt). A
 *  rel="noopener" _blank also has a null opener and is declined (conservative
 *  over guessing). Adopted into owned (listable, switch_tab-reachable) but NOT
 *  made active — a site-initiated popup must never steal the agent's current tab. */
async function adoptOpenedPage(host: PopupHost, p: Page): Promise<void> {
	try {
		if (p.isClosed() || host.isOwned(p)) return;
		let peers = host.peers();
		if (peers.includes(p)) return;
		const opener = await p.opener();
		if (!opener || !host.isOwned(opener)) return;
		// Re-check across the await — closed/owned AND peers. In shared mode a
		// peer manager's acquirePage can grab this still-blank popup during the
		// await; without the peer re-check we would double-own it.
		peers = host.peers();
		if (p.isClosed() || host.isOwned(p) || peers.includes(p)) return;
		host.adopt(p);
		host.addOwned(p);
		// Do NOT make it active: a "page" event is SITE-initiated (ad, analytics,
		// background window.open, OAuth). It is now listable and switch_tab-
		// reachable; the agent moves to it deliberately.
	} catch { /* the page/opener raced with a close — safe to skip */ }
}

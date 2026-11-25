/**
 * "Proceed anyway" past a certificate the browser does not trust, for a page
 * the USER typed into the pane's address bar.
 *
 * A router, a NAS or a printer serves its admin page over HTTPS with a
 * certificate it signed itself, so Chromium refuses it (ERR_CERT_AUTHORITY_
 * INVALID) and the pane had no way past (2026-11-24: the owner's own router).
 *
 * Who can get past, and what it trusts:
 * - Only the user. The button lives in the app's own window and comes back as
 *   "browser-cert-proceed", accepted only from that window; the agent drives
 *   page contents, never this window.
 * - Only for a host the user typed. A page the agent navigated to gets no
 *   button, so an agent steered by a hostile page cannot send the user to a
 *   look-alike site and ask them to click through.
 * - Only that host with that exact certificate, until the app quits. A
 *   different certificate for the same host (the shape of an interception)
 *   is refused again and asks again.
 */
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import { isTrustedBrowserSender } from "./browser-page-controls";
import { getBrowserView, viewIdForWebContents } from "./browser-views";

interface CertError {
	url: string;
	host: string;
	fingerprint: string;
	typedByUser: boolean;
}

/** host + certificate fingerprint pairs the user chose to trust this run. */
const trusted = new Set<string>();
/** The host the user last typed into each tab's address bar. */
const typedHosts = new WeakMap<WebContents, string>();
/** The last certificate error each tab hit. */
const certErrors = new WeakMap<WebContents, CertError>();

function hostOf(url: string): string | null {
	try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

const trustKey = (host: string, fingerprint: string) => `${host}|${fingerprint}`;

/** The user pressed Enter in the address bar of this tab (browser-ipc.ts). */
export function noteTypedNavigation(wc: WebContents, url: string): void {
	const host = hostOf(url);
	if (host) typedHosts.set(wc, host);
}

/** Decide one certificate error: true when the user already trusted this host
 *  with this certificate. Otherwise the error is kept for the button. */
export function decideCertificateError(wc: WebContents, url: string, fingerprint: string): boolean {
	const host = hostOf(url);
	if (!host) return false;
	if (trusted.has(trustKey(host, fingerprint))) return true;
	certErrors.set(wc, { url, host, fingerprint, typedByUser: typedHosts.get(wc) === host });
	return false;
}

/** Does this tab's failed load get a Proceed button? (browser-ipc-navstate.ts) */
export function canProceedPastCertificate(wc: WebContents, failedUrl: string): boolean {
	const err = certErrors.get(wc);
	return !!err && err.typedByUser && err.host === hostOf(failedUrl);
}

/** The user clicked Proceed: trust that host with that certificate, and load it again. */
export function proceedPastCertificate(wc: WebContents): boolean {
	const err = certErrors.get(wc);
	if (!err || !err.typedByUser) return false;
	trusted.add(trustKey(err.host, err.fingerprint));
	certErrors.delete(wc);
	console.log(`[browser.cert] user trusted the certificate of ${err.host} for this run`);
	void wc.loadURL(err.url).catch(() => { /* nav-state carries the outcome */ });
	return true;
}

export function setupBrowserCertProceed(): void {
	app.on("certificate-error", (event, wc, url, _error, certificate, callback) => {
		// Only the pane's tabs; the app's own window never accepts a bad
		// certificate. Not preventing the default is Chromium's refusal.
		if (viewIdForWebContents(wc.id) === null) return;
		if (!decideCertificateError(wc, url, certificate.fingerprint)) return;
		event.preventDefault();
		callback(true);
	});

	ipcMain.handle("browser-cert-proceed", (event: IpcMainInvokeEvent, viewId: string): boolean => {
		if (!isTrustedBrowserSender(event.sender)) return false;
		const view = getBrowserView(String(viewId));
		if (!view || view.webContents.isDestroyed()) return false;
		return proceedPastCertificate(view.webContents);
	});
}

/** Test seam: forget every trust decision. */
export function _resetCertTrustForTests(): void {
	trusted.clear();
}

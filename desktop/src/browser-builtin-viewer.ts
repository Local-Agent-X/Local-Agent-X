/**
 * Chromium's built-in PDF viewer, in the in-app browser.
 *
 * Opening a PDF loads Chromium's own viewer: a component extension whose pages
 * (chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html, its scripts
 * and styles) ship inside Electron and never touch the network. Every request
 * in a browser partition passes the egress check, which speaks http(s) only and
 * refused them, so the viewer never started and a PDF drew an empty box.
 *
 * Exactly this one origin is let through, decided on the desktop and never sent
 * to the server's egress check. Every other chrome-extension:// request stays
 * refused: the app installs no extensions, so another id is a page probing for
 * the user's installed extensions.
 *
 * Pure module (no electron imports) so the rule is unit-testable.
 */

/** Chromium's PDF viewer component extension (the same id in every Chromium). */
export const PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/** True for a request to the built-in PDF viewer's own files. */
export function isBuiltInPdfViewerRequest(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.protocol === "chrome-extension:" && parsed.host === PDF_VIEWER_EXTENSION_ID;
}

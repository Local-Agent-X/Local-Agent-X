/**
 * Chromium's built-in PDF viewer, in the in-app browser.
 *
 * Opening a PDF loads Chromium's own viewer: a component extension whose pages
 * (chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html, its scripts
 * and styles) then load Chromium's shared WebUI code from chrome://resources/
 * (its UI library, load-time data, mojo bindings). All of it ships inside
 * Electron and never touches the network. Every request in a browser partition
 * passes the egress check, which speaks http(s) only and refused both, so the
 * viewer drew an empty box, then (with its own pages allowed) a dark pane.
 *
 * Let through, decided on the desktop and never sent to the server's egress
 * check: the viewer's own origin, and chrome://resources/ only when the viewer
 * itself asks for it. Every other chrome-extension:// or chrome:// request stays
 * refused: the app installs no extensions, so another extension id is a page
 * probing for the user's installed ones, and a web page has no business loading
 * Chromium's internal pages.
 *
 * Pure module (no electron imports) so the rule is unit-testable.
 */

/** Chromium's PDF viewer component extension (the same id in every Chromium). */
export const PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

function parse(url: string | undefined): URL | null {
	if (!url) return null;
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

function isViewerOrigin(url: URL | null): boolean {
	return url !== null && url.protocol === "chrome-extension:" && url.host === PDF_VIEWER_EXTENSION_ID;
}

/**
 * True for a file the built-in PDF viewer needs: its own pages, or Chromium's
 * shared chrome://resources/ code when `requester` (the URL of the frame making
 * the request) is the viewer.
 */
export function isBuiltInPdfViewerRequest(url: string, requester?: string): boolean {
	const target = parse(url);
	if (isViewerOrigin(target)) return true;
	return target !== null && target.protocol === "chrome:" && target.host === "resources" && isViewerOrigin(parse(requester));
}

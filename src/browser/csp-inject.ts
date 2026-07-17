/**
 * csp-inject — response-side wiring that stamps the canonical agent-browser CSP
 * onto the CDP/Playwright backend's TOP-LEVEL DOCUMENT responses.
 *
 * WHY HERE (seam justification): the mandatory browser egress proxy only sees
 * plaintext HTTP responses (forwardHttp); HTTPS navigations pass through it as
 * an opaque CONNECT tunnel (openTunnel pipes ciphertext), so it can never read
 * or append a header on the document of an https:// site — which is nearly
 * every real page. Playwright's route.fetch()+route.fulfill() operates inside
 * the browser context AFTER TLS termination, so it can append the header on
 * every navigation regardless of scheme. That makes the request guard the only
 * seam that actually enforces the CSP on the document.
 *
 * The policy itself is owned by csp-policy.ts (buildAgentCsp); this file only
 * transports it onto the response. It is intentionally tiny and self-contained
 * so a later chunk editing guards.ts merges cleanly.
 */
import type { Route, Request } from "playwright";
import { buildAgentCsp } from "./csp-policy.js";

const CSP_HEADER = "content-security-policy";

/** Content types whose response Chromium renders as a document and enforces a
 *  document-level CSP against. Anything else (octet-stream, pdf, images, json,
 *  or a missing type) is an opaque/downloadable payload where a CSP is
 *  meaningless. */
const HTML_DOCUMENT_TYPES = ["text/html", "application/xhtml+xml"] as const;

/**
 * True only for the request whose response is the top-level (MAIN-frame)
 * document — the one Chromium enforces a document CSP against. Sub-resource
 * requests (images, scripts, XHR, fonts) return false so the caller keeps them
 * on the plain continue()/abort() path and never pays a fetch+fulfill
 * round-trip.
 *
 * CRITICAL — resourceType/isNavigationRequest alone are NOT enough. An iframe's
 * INITIAL load is ALSO resourceType:"document" + isNavigationRequest:true, so
 * those two predicates cannot tell an embedded frame's document apart from the
 * top-level one. Only the MAIN frame has no parent frame; every iframe has one.
 * We MUST NOT inject on an iframe document: buildAgentCsp stamps
 * `frame-ancestors 'none'`, which makes Chromium refuse to embed the frame and
 * breaks legitimate embeds (Stripe/payment, OAuth/SSO, map/video/widget), even
 * same-site. Hence the parentFrame() === null check.
 *
 * Fail SAFE: if request.frame()/parentFrame() is unavailable or throws in some
 * context, treat the request as NOT the top-level document (caller does a plain
 * continue, no CSP) so we can never break a frame — injecting is only ever for
 * the confirmed main document.
 */
export function isTopLevelDocument(request: Request): boolean {
	if (request.resourceType() !== "document" || !request.isNavigationRequest()) return false;
	try {
		const frame = request.frame();
		return frame != null && frame.parentFrame() === null;
	} catch {
		return false;
	}
}

/** A fetched response carries an enforceable document CSP only when it is a
 *  genuine, rendered HTML/XHTML document that is NOT flagged as a download.
 *  An `attachment` Content-Disposition or a non-HTML (or missing) Content-Type
 *  means the bytes are a download / opaque payload — stamping CSP is
 *  meaningless and would only interfere with the download pipeline. */
function isHtmlDocumentResponse(headers: Record<string, string>): boolean {
	if ((headers["content-disposition"] ?? "").toLowerCase().includes("attachment")) return false;
	const contentType = (headers["content-type"] ?? "").toLowerCase();
	return HTML_DOCUMENT_TYPES.some((type) => contentType.includes(type));
}

/**
 * Fetch the upstream document and fulfill it back to the page with our agent
 * CSP APPENDED as an ADDITIONAL Content-Security-Policy policy — never a
 * replacement. Chromium enforces the INTERSECTION of every policy present, so
 * appending can only ever TIGHTEN what the site already declares; a malicious
 * or permissive site CSP cannot loosen ours. When the site sends its own CSP we
 * comma-join (the CSP spec treats comma-separated policies in one header value
 * as independent policies, identical to sending two separate headers); the
 * flat header map Playwright's fulfill() takes cannot hold two same-named
 * headers, so comma-join is the faithful encoding.
 *
 * All other upstream headers are preserved verbatim (spread first).
 *
 * DOWNLOAD / NON-HTML GUARD: only after route.fetch() returns can we read the
 * response headers. If the response is an attachment or a non-HTML content type
 * it is a download (handled by Chromium's own download machinery — see
 * page.on("download") + the quarantine pipeline in downloads.ts) or an opaque
 * payload, so we DO NOT inject CSP. We already hold the fetched response, so we
 * fulfill it THROUGH unchanged — a second route.continue() would re-issue the
 * request and could double-submit a POST navigation.
 *
 * RESIDUAL: route.fetch() buffers the whole body once. Restricting the fetch
 * path to confirmed MAIN-frame document navigations (isTopLevelDocument) keeps
 * that buffering off iframes and sub-resources, but a main-frame navigation to
 * a very large HTML document (or a large attachment discovered only post-fetch)
 * still buffers once here. That is accepted and documented.
 * TODO(perf): a non-buffering path via the CDP Fetch.continueResponse
 * response-stage header override could append the CSP without buffering the
 * body at all; not built here.
 */
export async function fulfillWithAgentCsp(route: Route, url: string): Promise<void> {
	const response = await route.fetch();
	const headers: Record<string, string> = { ...response.headers() };
	if (!isHtmlDocumentResponse(headers)) {
		await route.fulfill({ response });
		return;
	}
	const agentCsp = buildAgentCsp(url);
	const existing = headers[CSP_HEADER];
	headers[CSP_HEADER] = existing ? `${existing}, ${agentCsp}` : agentCsp;
	await route.fulfill({ response, headers });
}

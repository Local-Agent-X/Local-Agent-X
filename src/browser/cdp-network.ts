/**
 * On-demand CDP response-body fetch leaf.
 *
 * Given a viewId + url, returns the JSON/text body a data endpoint served on
 * the live in-app page, over the real Playwright Page via CDP. This is the
 * FIRST production caller of getPageForView (electron-cdp.ts): when the CDP
 * endpoint is absent (dev / no-desktop) it returns an honest not-available
 * string — mirroring the not-supported posture of manager.ts's readNetwork —
 * and it NEVER throws. It returns a plain string; the tool layer wraps it.
 *
 * On-demand only (decision B1): response bodies are never eagerly buffered. A
 * per-view CDPSession sniffs response METADATA only (url -> requestId, cheap
 * and bounded, never bodies). When a read finds a requestId it pulls the
 * buffered body via Network.getResponseBody; otherwise — the common path, since
 * the sniffer only sees responses that arrive AFTER it first attaches — it
 * falls back to a session-sharing page.request.get(url) re-fetch, clearly
 * labeled as a re-fetch. The sniffer persists across calls so a requestId
 * captured now can serve a later read of the same url.
 *
 * The re-fetch is a request the MODEL chose, sent with the page's cookies, so
 * it answers to the same web-access policy every page request and navigation
 * does (evaluateEgressForUrl, the per-hop gate in guards.ts / bridge-egress.ts)
 * before it leaves; a refused URL returns the policy's reason as the result.
 * A buffered body needs no gate: the page's own request already passed it.
 *
 * Bounded by an isDataEndpoint content-type allowlist (decision B3, reused from
 * bridge-perception.ts — no binary/media) and a 100k-char in-memory cap
 * (decision B4 — truncate in memory, never spill to disk).
 */
import type { CDPSession, Page } from "playwright";
import type { SecurityDecision } from "../types.js";
import { createLogger } from "../logger.js";
import { getRuntimeConfig } from "../config.js";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { sendRefusal } from "../net/egress-send.js";
import { egressSessionId } from "../net/egress-scope.js";
import { getPageForView } from "./electron-cdp.js";
import { isDataEndpoint, type BridgeNetworkEntry } from "./bridge-perception.js";

const logger = createLogger("browser.cdp-network");

/** In-memory body cap (decision B4). Truncate HERE — never spill to disk. */
const MAX_CHARS = 100_000;

/** Cap the per-view metadata map so a busy page can't grow it unbounded. */
const MAX_META = 200;

/** Honest not-available string for the no-CDP case (dev / no desktop), mirroring
 *  manager.ts's readNetwork not-supported posture. */
const NOT_AVAILABLE =
	"Response-body capture is not available — it requires the in-app browser's " +
	"embedded CDP endpoint, which is not connected here. No response body was read.";

/** Prefix stamped on a re-fetched body so the agent knows it is NOT the exact
 *  bytes the page originally received. */
const REFETCH_PREFIX =
	"[re-fetched — original response body was no longer buffered; a param-driven " +
	"or one-shot endpoint may differ]\n";

/**
 * Resolves the live Playwright Page for a viewId. Injectable so tests can pass
 * a fake Page and never open a real socket — mirrors electron-cdp.ts's
 * module-level connector-setter seam.
 */
export type PageProvider = (viewId: string) => Promise<Page | null>;

let pageProvider: PageProvider = getPageForView;

/** The web-access decision for a URL the model asked to re-fetch. Injectable
 *  for the same reason as the page provider: the policy reads live config. */
export type RefetchGate = (url: string) => SecurityDecision;

const policyGate: RefetchGate = (url) =>
	evaluateEgressForUrl(url, process.env.LAX_PORT ?? String(getRuntimeConfig().port));

let refetchGate: RefetchGate = policyGate;

interface ResponseMeta {
	requestId: string;
	mimeType: string;
	resourceType: string;
}

interface ViewSniffer {
	session: CDPSession;
	meta: Map<string, ResponseMeta>;
}

// One metadata sniffer per view, kept alive across reads so a response that
// arrives AFTER the first read can serve a later read of the same url.
const sniffers = new Map<string, ViewSniffer>();

/**
 * Lazily attach a per-view response-metadata sniffer (decision B1: metadata
 * only, never bodies). Reused across calls. Returns null if the CDP attach
 * fails — the caller then falls back to a re-fetch. Never throws.
 */
async function ensureSniffer(viewId: string, page: Page): Promise<ViewSniffer | null> {
	const existing = sniffers.get(viewId);
	if (existing) return existing;
	try {
		const session = await page.context().newCDPSession(page);
		await session.send("Network.enable");
		const meta = new Map<string, ResponseMeta>();
		session.on("Network.responseReceived", (evt) => {
			// Newest wins; delete-then-set keeps insertion order newest-last so the
			// eviction below drops the OLDEST entry once over the cap.
			meta.delete(evt.response.url);
			meta.set(evt.response.url, {
				requestId: evt.requestId,
				mimeType: evt.response.mimeType,
				resourceType: evt.type.toLowerCase(),
			});
			while (meta.size > MAX_META) {
				const oldest = meta.keys().next().value;
				if (oldest === undefined) break;
				meta.delete(oldest);
			}
		});
		const sniffer: ViewSniffer = { session, meta };
		sniffers.set(viewId, sniffer);
		return sniffer;
	} catch (err) {
		logger.warn(`sniffer attach failed for ${viewId}: ${(err as Error).message}`);
		return null;
	}
}

/**
 * Content-type allowlist gate (decision B3): reuse isDataEndpoint EXACTLY by
 * building a minimal BridgeNetworkEntry. Returns a refusal string naming the
 * content-type when the body is not a data endpoint, or null when allowed.
 */
function refuseIfNotData(url: string, contentType: string | undefined, resourceType: string | undefined): string | null {
	const entry: BridgeNetworkEntry = { url, method: "GET", contentType, resourceType, ts: 0 };
	if (isDataEndpoint(entry)) return null;
	const shown = contentType && contentType.trim() !== "" ? contentType : "unknown";
	return (
		`Refusing to return the response body for ${url}: its content-type (${shown}) ` +
		"is not a data endpoint. Only JSON/text/XML/RSS bodies are captured — no binary or media."
	);
}

/** Truncate in memory only (decision B4) — never spill to disk. */
function bound(body: string): string {
	if (body.length <= MAX_CHARS) return body;
	return body.slice(0, MAX_CHARS) + `\n[truncated — body exceeded ${MAX_CHARS} chars]`;
}

/** Pull a buffered body by requestId. Returns null (never throws) when the body
 *  was evicted or the call fails, so the caller can re-fetch. */
async function tryGetResponseBody(session: CDPSession, requestId: string): Promise<string | null> {
	try {
		const res = await session.send("Network.getResponseBody", { requestId });
		if (typeof res.body !== "string" || res.body === "") return null;
		return res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
	} catch (err) {
		logger.warn(`getResponseBody failed for ${requestId}: ${(err as Error).message}`);
		return null;
	}
}

/** Redirect hops a re-fetch follows, each judged like the first. */
const MAX_REFETCH_HOPS = 5;

/** Why this hop may not be sent, or null: the web-access policy, then the
 *  send-time judge on the URL against the calling tool's session (a canary,
 *  bytes the session read, a stored secret's value). */
function refetchRefusal(url: string): string | null {
	const decision = refetchGate(url);
	if (!decision.allowed) {
		return (
			`The response body for ${url} is no longer buffered and re-fetching it was refused by the web-access policy: ${decision.reason}` +
			(decision.recovery ? `\nRecovery: ${decision.recovery}` : "")
		);
	}
	let host = "the page's host";
	try { host = new URL(url).host; } catch { /* the policy refuses an unparseable URL first */ }
	const judged = sendRefusal(egressSessionId() ?? "", url, `the re-fetch to ${host}`);
	return judged ? `The response body is no longer buffered and re-fetching it was refused. ${judged}` : null;
}

/** Session-sharing re-fetch (Playwright APIRequestContext carries the context's
 *  cookies). Redirects are followed here, not by Playwright, so every hop is
 *  judged before it leaves. Labeled as a re-fetch; content-type gated on the
 *  response header. */
async function reFetch(page: Page, url: string): Promise<string> {
	let current = url;
	for (let hop = 0; hop <= MAX_REFETCH_HOPS; hop++) {
		const refused = refetchRefusal(current);
		if (refused) return refused;
		const resp = await page.request.get(current, { maxRedirects: 0 });
		const location = resp.status() >= 300 && resp.status() < 400 ? resp.headers()["location"] : undefined;
		if (location) {
			current = new URL(location, current).href;
			continue;
		}
		const refusal = refuseIfNotData(current, resp.headers()["content-type"], undefined);
		if (refusal) return refusal;
		return REFETCH_PREFIX + bound(await resp.text());
	}
	return `The response body for ${url} is no longer buffered, and re-fetching it redirected more than ${MAX_REFETCH_HOPS} times. No body was read.`;
}

/**
 * Return the bounded, labeled response body a data endpoint served for `url` on
 * the view's live page — buffered via getResponseBody when the sniffer holds
 * its requestId, otherwise a labeled re-fetch. Returns a plain not-available or
 * refusal message instead of throwing.
 */
export async function readResponseBody(viewId: string, url: string): Promise<string> {
	try {
		const page = await pageProvider(viewId);
		if (!page) return NOT_AVAILABLE;

		const sniffer = await ensureSniffer(viewId, page);
		const hit = sniffer?.meta.get(url);
		if (sniffer && hit) {
			// The CDP metadata already carries the type, so gate BEFORE pulling the
			// body — a binary/media endpoint is refused without a wasted read.
			const refusal = refuseIfNotData(url, hit.mimeType, hit.resourceType);
			if (refusal) return refusal;
			const body = await tryGetResponseBody(sniffer.session, hit.requestId);
			if (body !== null) return bound(body);
			// getResponseBody failed / body evicted → fall through to re-fetch.
		}
		return await reFetch(page, url);
	} catch (err) {
		logger.warn(`readResponseBody(${viewId}) failed: ${(err as Error).message}`);
		return `Could not read the response body for ${url}: ${(err as Error).message}`;
	}
}

/**
 * Test seam: override the page provider (pass null to restore getPageForView).
 * Also clears cached sniffers so each test starts clean — mirrors the reset
 * side-effect of electron-cdp.ts's _setConnectorForTest.
 */
export function _setPageProviderForTest(fn: PageProvider | null): void {
	pageProvider = fn ?? getPageForView;
	sniffers.clear();
}

/** Test seam: override the re-fetch gate (pass null to restore the policy). */
export function _setRefetchGateForTest(fn: RefetchGate | null): void {
	refetchGate = fn ?? policyGate;
}

/**
 * Local Agent X — Browser partition hardening
 *
 * Every in-app browser view lives on a per-profile session partition
 * (`persist:lax-profile-<id>`) — NEVER the app default session, which
 * carries AUTH_TOKEN. The defaultSession handlers in
 * session-permissions.ts do not apply to partitions, so this module
 * replicates the security stack per partition: deny-by-default
 * permissions, download quarantine, service-worker blocking, and
 * per-hop fail-closed egress with a pluggable evaluator (the real
 * policy lives server-side and is wired via setEgressEvaluator by a
 * later chunk — no policy logic is duplicated here).
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { app, session, type DownloadItem, type Session, type WebContents, type WebPreferences } from "electron";

import { LAX_DIR, getLAXConfig } from "./config";
import { noteRequestDone, noteRequestFailed, noteRequestStart } from "./browser-perception";
import { shouldAllowUserLoopback, type ViewTrust } from "./browser-loopback-policy";
import { isUserDownload, uniqueDownloadPath, type QuarantinedDownload } from "./browser-download-routing";
import { recordUserDownload, updateUserDownload } from "./browser-user-download-registry";
import {
	buildHardeningCspHeaders,
	cacheGet,
	cacheSet,
	clearDecisionCache,
	extractUploadBody,
} from "./browser-partition-net";

const PARTITION_PREFIX = "persist:lax-profile-";

// ── App-wide network hardening (must run before app.ready) ─────────
// Electron only offers APP-WIDE switches for QUIC and DNS-over-HTTPS —
// there is no per-partition control. Accepted scope: the main window
// only ever talks to the loopback app origin, so disabling QUIC and
// DoH globally costs it nothing while denying browser-view content a
// UDP/encrypted-DNS path around the per-hop egress evaluator below.
let networkHardeningApplied = false;

export function initBrowserNetworkHardening(): void {
	if (networkHardeningApplied) return;
	networkHardeningApplied = true;
	app.commandLine.appendSwitch("disable-quic");
	// DoH can only be configured after app.ready; queue it here so the
	// one wire call in main.ts covers both.
	void app.whenReady().then(() => {
		app.configureHostResolver({ secureDnsMode: "off" });
	});
}

// ── View-trust seam (user vs agent views) ─────────
// browser-views.ts registers a resolver mapping a webContents id to whether
// its pool view is user-driven or agent-driven. Setter pattern — importing
// browser-views here would be a cycle (it imports this module). Used only by
// the user-loopback carve-out below; unresolvable ids stay strict.
export type ViewTrustResolver = (webContentsId: number) => ViewTrust | null;

let viewTrustResolver: ViewTrustResolver | null = null;

export function setViewTrustResolver(fn: ViewTrustResolver | null): void {
	viewTrustResolver = fn;
}

// ── Egress evaluation seam (per-hop, fail-closed) ─────────
// The seam carries a REQUEST (not just a URL) so the server-side evaluator can
// run its taint/canary payload scan: it needs the outbound body, the requesting
// page origin (to tell a first-party hop from a cross-domain one), and the
// webContents (→ owning view → session). URL-only SSRF policy still runs first.
export interface EgressRequest {
	/** The outbound request URL. */
	url: string;
	/** HTTP method (GET/POST/…); undefined treated as GET. */
	method?: string;
	/** Requesting frame/page URL — the first-party origin the request issues
	 *  from. Only a CROSS-registrable-domain hop carrying tainted bytes is exfil;
	 *  a first-party hop is always allowed by the taint gate. */
	pageUrl?: string;
	/** Decoded outbound body bytes (POST/PUT/PATCH), size-capped; undefined for
	 *  bodyless requests. The primary exfil payload channel. */
	body?: string;
	/** webContents that issued the request. The server resolves it to the owning
	 *  view → session so the taint/canary scan runs against the right session. */
	webContentsId?: number;
}
export type EgressDecision = { allowed: boolean };
export type EgressEvaluator = (req: EgressRequest) => Promise<EgressDecision> | EgressDecision;

let egressEvaluator: EgressEvaluator | null = null;

/**
 * Plug in the real egress policy (an IPC ask to the server process,
 * which owns the one source of truth). Until this is called, the
 * default is fail-closed: only the loopback app origin is allowed.
 */
export function setEgressEvaluator(fn: EgressEvaluator): void {
	egressEvaluator = fn;
	clearDecisionCache();
}

// The app's own loopback origin — the only destination allowed before the real
// server-side evaluator is wired (fail-closed default). Coupled to getLAXConfig,
// so it stays here rather than in the pure browser-partition-net leaf.
function isLoopbackAppUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol !== "http:") return false;
		const host = u.hostname.toLowerCase();
		if (host !== "127.0.0.1" && host !== "localhost") return false;
		return u.port === String(getLAXConfig().port);
	} catch {
		return false;
	}
}

async function evaluateEgress(req: EgressRequest): Promise<boolean> {
	// Cache only BODYLESS requests: their decision is keyed by the full URL (which
	// already carries any query/path-encoded payload), so a cache hit is the same
	// payload. A request WITH a body carries its exfil payload out-of-band from the
	// URL, so its decision must be recomputed each time (never cached, never a hit)
	// — otherwise two POSTs to the same URL with different bodies would collide.
	const cacheable = !req.body;
	if (cacheable) {
		const cached = cacheGet(req.url);
		if (cached !== null) return cached;
	}
	let allowed = false;
	if (egressEvaluator) {
		try {
			allowed = (await egressEvaluator(req)).allowed === true;
		} catch {
			allowed = false; // evaluator failure = fail closed
		}
	} else {
		// No evaluator wired yet: allow only the loopback app origin.
		allowed = isLoopbackAppUrl(req.url);
	}
	if (cacheable) cacheSet(req.url, allowed);
	return allowed;
}

// ── Download quarantine registry ─────────
// Record shape lives in browser-download-routing.ts; re-exported so the
// bridge keeps its import surface.
export type { QuarantinedDownload } from "./browser-download-routing";

const QUARANTINE_DIR = join(LAX_DIR, "quarantine");
const downloadRegistry = new Map<string, QuarantinedDownload>();

export function getQuarantinedDownload(id: string): QuarantinedDownload | undefined {
	return downloadRegistry.get(id);
}

export function listQuarantinedDownloads(): QuarantinedDownload[] {
	return [...downloadRegistry.values()];
}

export function _resetDownloadRegistryForTest(): void {
	downloadRegistry.clear();
}

// Attribution + terminal-state seams (browser-downloads-bridge.ts wires
// both). Setter pattern — importing browser-views here would be a cycle.
export type DownloadContextResolver = (wc: WebContents | undefined) => { viewId: string | null; pageUrl: string };
let downloadContextResolver: DownloadContextResolver | null = null;
export function setDownloadContextResolver(fn: DownloadContextResolver | null): void {
	downloadContextResolver = fn;
}

let downloadDoneListener: ((entry: QuarantinedDownload) => void) | null = null;
export function setDownloadDoneListener(fn: ((entry: QuarantinedDownload) => void) | null): void {
	downloadDoneListener = fn;
}

// ── Per-partition hardening ─────────
const hardenedPartitions = new Set<string>();

/**
 * Resolve a browser-profile partition to its Session, applying the
 * full hardening stack exactly once per partition. Refuses anything
 * outside the profile namespace — `session.fromPartition("")` would
 * hand back the app default session (AUTH_TOKEN holder).
 */
export function getHardenedPartitionSession(partition: string): Session {
	if (!partition.startsWith(PARTITION_PREFIX)) {
		throw new Error(`refusing partition "${partition}" — browser views must use ${PARTITION_PREFIX}<id>`);
	}
	const sess = session.fromPartition(partition);
	if (hardenedPartitions.has(partition)) return sess;
	hardenedPartitions.add(partition);
	hardenSession(sess, partition);
	return sess;
}

// Web content gets nothing by default. clipboard-sanitized-write is
// the one concession (lets pages service a user-initiated copy).
const VIEW_ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

// Chromium reports service-worker script fetches with this resourceType
// at runtime; Electron's TS union omits it, so membership goes through a
// Set<string> rather than a (type-error) literal comparison.
const SW_RESOURCE_TYPES: ReadonlySet<string> = new Set(["serviceWorker"]);

function hardenSession(sess: Session, partition: string): void {
	sess.setPermissionRequestHandler(
		(_wc: WebContents | null, permission: string, callback: (granted: boolean) => void) => {
			callback(VIEW_ALLOWED_PERMISSIONS.has(permission));
		},
	);
	sess.setPermissionCheckHandler(
		(_wc: WebContents | null, permission: string) => VIEW_ALLOWED_PERMISSIONS.has(permission),
	);

	// Agent downloads land ONLY in quarantine, nothing auto-opens; the server
	// owns release/approval via the done-listener seam
	// (browser-downloads-bridge.ts). A download the trust resolver POSITIVELY
	// attributes to a USER view is the user's own browsing and lands in
	// ~/Downloads like any browser (browser-download-routing.ts); popups and
	// unresolvable webContents fail safe into quarantine.
	sess.on("will-download", (_event: unknown, item: DownloadItem, wc?: WebContents) => {
		if (isUserDownload(wc && !wc.isDestroyed() ? wc.id : undefined, viewTrustResolver)) {
			const savePath = uniqueDownloadPath(app.getPath("downloads"), item.getFilename(), existsSync);
			item.setSavePath(savePath);
			const id = randomUUID();
			recordUserDownload({
				id, filename: item.getFilename(), savePath, url: item.getURL(),
				bytes: 0, totalBytes: item.getTotalBytes(), state: "progressing", startedAt: Date.now(),
			});
			item.on("updated", () => updateUserDownload(id, { bytes: item.getReceivedBytes() }));
			item.once("done", (_e: unknown, state: "completed" | "cancelled" | "interrupted") => {
				updateUserDownload(id, { bytes: item.getReceivedBytes(), state, doneAt: Date.now() });
				if (state === "completed" && process.platform === "darwin") app.dock?.downloadFinished(savePath);
			});
			return;
		}
		const id = randomUUID();
		mkdirSync(QUARANTINE_DIR, { recursive: true });
		const savePath = join(QUARANTINE_DIR, `${id}.part`);
		item.setSavePath(savePath);
		// Attribute at DOWNLOAD time — the view may be gone by the time anyone
		// lists the registry. No resolver wired yet → unattributed (null).
		let context = { viewId: null as string | null, pageUrl: "" };
		try {
			if (downloadContextResolver) context = downloadContextResolver(wc);
		} catch {
			/* attribution is best-effort; the quarantine save is not */
		}
		const record: QuarantinedDownload = {
			id,
			viewId: context.viewId,
			pageUrl: context.pageUrl,
			url: item.getURL(),
			filename: item.getFilename(),
			mime: item.getMimeType(),
			bytes: item.getTotalBytes(),
			state: "progressing",
			savePath,
			reported: false,
		};
		downloadRegistry.set(id, record);
		item.on("updated", (_e: unknown, state: string) => {
			record.bytes = item.getReceivedBytes();
			if (state === "interrupted") record.state = "interrupted";
		});
		item.once("done", (_e: unknown, state: "completed" | "cancelled" | "interrupted") => {
			record.bytes = item.getReceivedBytes();
			record.state = state;
			try {
				downloadDoneListener?.(record);
			} catch {
				/* push is best-effort; the outbox flush retries unreported entries */
			}
		});
	});

	// Single onBeforeRequest handler per session (Electron replaces, not
	// stacks): service-worker script fetches are cancelled outright, and
	// every other request — including each redirect hop, which re-enters
	// here with the new URL — must pass the egress evaluator. The perception
	// in-flight counter rides the SAME single handler (composed here, never a
	// second registration): every start is balanced by exactly one
	// onCompleted/onErrorOccurred below — cancelled requests (SW block,
	// egress deny) also settle through onErrorOccurred.
	sess.webRequest.onBeforeRequest((details, callback) => {
		// details.id is stable across a redirect chain's hops — the perception
		// side keys in-flight on an unsettled-id SET, so per-hop re-entry here
		// (load-bearing for egress) can't drift the count.
		noteRequestStart(partition, details.id);
		if (SW_RESOURCE_TYPES.has(details.resourceType)) {
			callback({ cancel: true });
			return;
		}
		// USER-view loopback carve-out (browser-loopback-policy.ts): the user's
		// own tabs may reach literal-loopback services (their ComfyUI, their dev
		// server) the way Chrome allows — top-level navs + loopback-initiated
		// subresources. Decided HERE, never through evaluateEgress: the decision
		// cache is keyed by URL alone, so a user-view allow cached there would
		// leak to an agent view requesting the same URL within the TTL.
		// Electron's webRequest details carry no `initiator`; the requesting
		// frame's URL is the equivalent (and page-unforgeable) signal, with the
		// referrer as fallback (referrer-policy can only SHRINK it, so it can
		// never fake a loopback origin — worst case we fail strict).
		let requester: string | undefined;
		try {
			requester = details.frame?.url || details.referrer || undefined;
		} catch {
			requester = undefined;
		}
		if (
			viewTrustResolver &&
			shouldAllowUserLoopback(
				{
					url: details.url,
					resourceType: details.resourceType,
					initiator: requester,
					webContentsId: details.webContentsId,
				},
				viewTrustResolver,
			)
		) {
			callback({ cancel: false });
			return;
		}
		// Hand the server evaluator everything its taint/canary scan needs: the
		// URL (SSRF/host policy), the requesting page origin (first-party vs
		// cross-domain), the outbound body (primary exfil channel), and the
		// webContents (→ owning view → session).
		void evaluateEgress({
			url: details.url,
			method: details.method,
			pageUrl: requester,
			body: extractUploadBody(details.uploadData),
			webContentsId: details.webContentsId,
		}).then(
			(allowed) => callback({ cancel: !allowed }),
			() => callback({ cancel: true }),
		);
	});

	// Agent perception: per-request outcomes into the partition's bounded
	// network ring (browser-perception.ts). Session-scoped by design — the
	// read op resolves a viewId to its partition.
	sess.webRequest.onCompleted((details) => {
		noteRequestDone(partition, { id: details.id, url: details.url, method: details.method, statusCode: details.statusCode });
	});
	sess.webRequest.onErrorOccurred((details) => {
		noteRequestFailed(partition, { id: details.id, url: details.url, method: details.method, error: details.error });
	});

	// Hardening-only CSP on the TOP-LEVEL document. A same-site *fetch-scoping* CSP
	// (script/style/img/connect pinned to the page's own domain) was tried and
	// reverted — it broke every multi-CDN site (x.com's JS lives on abs.twimg.com,
	// google's on gstatic.com), stopping the SPA from booting. What IS safe to
	// stamp is the zero-rendering-cost hardening trio (object-src/base-uri/
	// frame-ancestors), which never gates where a page loads its own subresources
	// from. APPEND (never replace) so Chromium enforces the intersection — it can
	// only tighten. MAIN-FRAME only: on a sub-frame, frame-ancestors 'none' makes
	// Chromium refuse legit embeds (Stripe/OAuth/maps). Cross-origin EXFIL is
	// governed separately by the taint-aware payload scan in the egress evaluator
	// above (server-side page-egress-taint.ts), which allows CDN/API reads while
	// blocking a cross-domain hop that actually carries tainted bytes.
	sess.webRequest.onHeadersReceived((details, callback) => {
		if (details.resourceType !== "mainFrame") {
			callback({});
			return;
		}
		callback({ responseHeaders: buildHardeningCspHeaders(details.responseHeaders as Record<string, string[]> | undefined) });
	});
}

// ── Per-view helpers (called by browser-views.ts) ─────────
/**
 * webPreferences for browser-view webContents. Mirrors the probe
 * window (server-bridge.ts): no node, isolated, sandboxed. NO preload
 * — view content must never see ipcRenderer. backgroundThrottling is
 * off so detached/hidden views still accept sendInputEvent (throttled
 * views silently DROP input events — verified on Electron 35.7.5).
 */
export function viewWebPreferences(partition: string): WebPreferences {
	getHardenedPartitionSession(partition); // ensure hardening precedes first use
	return {
		partition,
		nodeIntegration: false,
		contextIsolation: true,
		sandbox: true,
		backgroundThrottling: false,
	};
}

export function hardenWebContents(wc: WebContents): void {
	// Keep WebRTC from carrying raw UDP around the egress evaluator
	// (which only sees HTTP-stack requests).
	wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

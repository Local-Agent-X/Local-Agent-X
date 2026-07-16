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
import { mkdirSync } from "fs";
import { join } from "path";
import { app, session, type DownloadItem, type Session, type WebContents, type WebPreferences } from "electron";

import { LAX_DIR, getLAXConfig } from "./config";
import { noteRequestDone, noteRequestFailed, noteRequestStart } from "./browser-perception";

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

// ── Egress evaluation seam (per-hop, fail-closed) ─────────
export type EgressDecision = { allowed: boolean };
export type EgressEvaluator = (url: string) => Promise<EgressDecision> | EgressDecision;

let egressEvaluator: EgressEvaluator | null = null;

/**
 * Plug in the real egress policy (an IPC ask to the server process,
 * which owns the one source of truth). Until this is called, the
 * default is fail-closed: only the loopback app origin is allowed.
 */
export function setEgressEvaluator(fn: EgressEvaluator): void {
	egressEvaluator = fn;
	decisionCache.clear();
}

// Small LRU over egress decisions — Map iteration order is insertion
// order, so the first key is the least recently used.
const CACHE_MAX_ENTRIES = 512;
const CACHE_TTL_MS = 30_000;
const decisionCache = new Map<string, { allowed: boolean; expiresAt: number }>();

function cacheGet(url: string): boolean | null {
	const entry = decisionCache.get(url);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		decisionCache.delete(url);
		return null;
	}
	decisionCache.delete(url); // refresh recency
	decisionCache.set(url, entry);
	return entry.allowed;
}

function cacheSet(url: string, allowed: boolean): void {
	if (decisionCache.has(url)) decisionCache.delete(url);
	else if (decisionCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = decisionCache.keys().next().value;
		if (oldest !== undefined) decisionCache.delete(oldest);
	}
	decisionCache.set(url, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
}

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

async function evaluateEgress(url: string): Promise<boolean> {
	const cached = cacheGet(url);
	if (cached !== null) return cached;
	let allowed = false;
	if (egressEvaluator) {
		try {
			allowed = (await egressEvaluator(url)).allowed === true;
		} catch {
			allowed = false; // evaluator failure = fail closed
		}
	} else {
		// No evaluator wired yet: allow only the loopback app origin.
		allowed = isLoopbackAppUrl(url);
	}
	cacheSet(url, allowed);
	return allowed;
}

// ── Download quarantine registry ─────────
export interface QuarantinedDownload {
	id: string;
	url: string;
	filename: string;
	mime: string;
	bytes: number;
	state: "progressing" | "completed" | "cancelled" | "interrupted";
	savePath: string;
}

const QUARANTINE_DIR = join(LAX_DIR, "quarantine");
const downloadRegistry = new Map<string, QuarantinedDownload>();

export function getQuarantinedDownload(id: string): QuarantinedDownload | undefined {
	return downloadRegistry.get(id);
}

export function listQuarantinedDownloads(): QuarantinedDownload[] {
	return [...downloadRegistry.values()];
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

	// Nothing lands outside quarantine, nothing auto-opens. Release /
	// approval flow is server-owned and wired in a later chunk.
	sess.on("will-download", (_event: unknown, item: DownloadItem) => {
		const id = randomUUID();
		mkdirSync(QUARANTINE_DIR, { recursive: true });
		const savePath = join(QUARANTINE_DIR, `${id}.part`);
		item.setSavePath(savePath);
		const record: QuarantinedDownload = {
			id,
			url: item.getURL(),
			filename: item.getFilename(),
			mime: item.getMimeType(),
			bytes: item.getTotalBytes(),
			state: "progressing",
			savePath,
		};
		downloadRegistry.set(id, record);
		item.on("updated", (_e: unknown, state: string) => {
			record.bytes = item.getReceivedBytes();
			if (state === "interrupted") record.state = "interrupted";
		});
		item.once("done", (_e: unknown, state: "completed" | "cancelled" | "interrupted") => {
			record.bytes = item.getReceivedBytes();
			record.state = state;
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
		noteRequestStart(partition);
		if (SW_RESOURCE_TYPES.has(details.resourceType)) {
			callback({ cancel: true });
			return;
		}
		void evaluateEgress(details.url).then(
			(allowed) => callback({ cancel: !allowed }),
			() => callback({ cancel: true }),
		);
	});

	// Agent perception: per-request outcomes into the partition's bounded
	// network ring (browser-perception.ts). Session-scoped by design — the
	// read op resolves a viewId to its partition.
	sess.webRequest.onCompleted((details) => {
		noteRequestDone(partition, { url: details.url, method: details.method, statusCode: details.statusCode });
	});
	sess.webRequest.onErrorOccurred((details) => {
		noteRequestFailed(partition, { url: details.url, method: details.method, error: details.error });
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

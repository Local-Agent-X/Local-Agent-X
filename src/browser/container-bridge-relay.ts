import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { BrowserViewInfo } from "./bridge-client-contract.js";
import { viewBelongsToSession } from "./bridge-perception.js";
import {
	encodeFrame,
	exchange,
	isRecord,
	MAX_BROWSER_RELAY_FRAME_BYTES,
	sealFrame,
	validateEndpoint,
	verifyFrame,
	type RelayFrame,
	type RelayResponse,
} from "./container-bridge-transport.js";
import {
	applyForwardedLineage,
	assertLineagePayload,
	type BrowserRelayLineageSink,
	type RelayLineagePayload,
} from "./container-bridge-lineage.js";

// The wire framing/crypto/client transport and the relay-activation config now
// live in container-bridge-transport.ts (shared with the lineage forwarder);
// re-exported here so existing importers keep their import site unchanged.
export {
	CONTAINER_BROWSER_RELAY_FLAG,
	CONTAINER_BROWSER_RELAY_SOCKET,
	CONTAINER_BROWSER_RELAY_TOKEN,
	MAX_BROWSER_RELAY_FRAME_BYTES,
	browserContainerRelayActivated,
} from "./container-bridge-transport.js";
export type { BrowserRelayLineageSink } from "./container-bridge-lineage.js";

export interface BrowserRelayRequest {
	op: string;
	viewId: string;
	message: Record<string, unknown>;
	timeoutMs: number;
}

export interface BrowserRelayHandler {
	request(request: BrowserRelayRequest): Promise<unknown>;
	abort(viewId: string): void | Promise<void>;
}

export interface BrowserRelayServerHandle {
	socketPath: string;
	close(): Promise<void>;
}

interface RelayPayload {
	// "taint"/"canaries" carry data-lineage forwarding (see
	// container-bridge-lineage.ts); their sessionId/entries/canaries fields are
	// validated by assertLineagePayload rather than typed on this op shape.
	kind: "request" | "abort" | "taint" | "canaries";
	request?: BrowserRelayRequest;
	viewId?: string;
}

const ALLOWED_OPS = new Set([
	"lifecycle:create", "lifecycle:show", "lifecycle:hide", "lifecycle:close",
	"lifecycle:setBounds", "lifecycle:ping", "lifecycle:list", "navigate",
	"read-console", "read-network", "dialogs:list", "dialogs:accept",
	"dialogs:dismiss", "exec", "input", "capture", "clear-partition",
]);
const activeServers = new Map<string, BrowserRelayServerHandle>();

export async function relayBrowserRequest(request: BrowserRelayRequest): Promise<unknown> {
	validateRequest(request);
	return exchange({ kind: "request", request }, request.timeoutMs + 1_000);
}

export async function relayBrowserAbort(viewId: string): Promise<void> {
	assertViewId(viewId);
	await exchange({ kind: "abort", viewId }, 5_000);
}

export async function startBrowserContainerRelay(options: {
	socketPath: string;
	token: string;
	/** The session that owns this relay. Every relayed op may only target a
	 *  view named for this session (view-<ownerSessionId>-<profile>); a viewId
	 *  belonging to an unrelated session (or none) is refused — see
	 *  viewBelongsToSession for the exact boundary, which admits this session's
	 *  own hyphen-nested descendants but never an unrelated top-level session.
	 *  The token proves only container membership, so this is what keeps one
	 *  container off another session's browser views. */
	ownerSessionId: string;
	handler: BrowserRelayHandler;
	/** Optional sink for forwarded data-lineage state (container taint/canaries).
	 *  Absent → lineage frames are still authenticated + session-checked but
	 *  applied nowhere. The host wiring binds it to the canonical registries. */
	lineage?: BrowserRelayLineageSink;
}): Promise<BrowserRelayServerHandle> {
	validateEndpoint(options.socketPath, options.token);
	assertOwnerSessionId(options.ownerSessionId);
	await activeServers.get(options.socketPath)?.close();
	removeStaleSocket(options.socketPath);
	const sockets = new Set<Socket>();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleSocket(socket, options.token, options.ownerSessionId, options.handler, options.lineage);
	});
	await listen(server, options.socketPath);
	if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);
	let closed = false;
	const handle: BrowserRelayServerHandle = {
		socketPath: options.socketPath,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			await closeServer(server);
			removeOwnedSocket(options.socketPath);
			if (activeServers.get(options.socketPath) === handle) {
				activeServers.delete(options.socketPath);
			}
		},
	};
	activeServers.set(options.socketPath, handle);
	return handle;
}

function handleSocket(
	socket: Socket,
	token: string,
	ownerSessionId: string,
	handler: BrowserRelayHandler,
	lineage: BrowserRelayLineageSink | undefined,
): void {
	let bytes = 0;
	let body = "";
	let handled = false;
	const decoder = new StringDecoder("utf8");
	socket.setTimeout(65_000, () => socket.destroy());
	socket.on("data", chunk => {
		if (handled) return;
		bytes += chunk.length;
		if (bytes > MAX_BROWSER_RELAY_FRAME_BYTES) { socket.destroy(); return; }
		body += decoder.write(chunk);
		const newline = body.indexOf("\n");
		if (newline < 0) return;
		if (body.slice(newline + 1).trim() !== "") { socket.destroy(); return; }
		handled = true;
		void serveFrame(socket, body.slice(0, newline), token, ownerSessionId, handler, lineage);
	});
}

async function serveFrame(
	socket: Socket,
	body: string,
	token: string,
	ownerSessionId: string,
	handler: BrowserRelayHandler,
	lineage: BrowserRelayLineageSink | undefined,
): Promise<void> {
	let frame: RelayFrame;
	try {
		frame = verifyFrame(body, token);
		validatePayload(frame.payload);
	} catch {
		socket.destroy();
		return;
	}
	let response: RelayResponse;
	try {
		const payload = frame.payload as RelayPayload;
		if (payload.kind === "abort") {
			assertOwnedView(payload.viewId as string, ownerSessionId);
			await handler.abort(payload.viewId as string);
			response = { ok: true };
		} else if (payload.kind === "taint" || payload.kind === "canaries") {
			// Data-lineage forwarding: session-binding enforced inside (a
			// cross-session forward throws → the whole frame is refused).
			applyForwardedLineage(frame.payload as RelayLineagePayload, ownerSessionId, lineage);
			response = { ok: true };
		} else {
			const request = payload.request as BrowserRelayRequest;
			response = { ok: true, result: await authorizeAndRun(request, ownerSessionId, handler) };
		}
	} catch (error) {
		response = { ok: false, error: serializeError(error) };
	}
	let encoded: string;
	try {
		encoded = encodeFrame(sealFrame(response, token, frame.id));
	} catch {
		encoded = encodeFrame(sealFrame({ ok: false, error: {
			name: "Error", message: "browser relay response exceeded its limit",
		} }, token, frame.id));
	}
	socket.end(encoded);
}

function validatePayload(payload: unknown): asserts payload is RelayPayload {
	if (!isRecord(payload)) throw new Error("invalid browser relay payload");
	if (payload.kind === "abort") { assertViewId(payload.viewId); return; }
	if (payload.kind === "taint" || payload.kind === "canaries") { assertLineagePayload(payload); return; }
	if (payload.kind !== "request") throw new Error("invalid browser relay operation");
	validateRequest(payload.request);
}

function validateRequest(value: unknown): asserts value is BrowserRelayRequest {
	if (!isRecord(value) || typeof value.op !== "string" || !ALLOWED_OPS.has(value.op)
		|| !isRecord(value.message) || !Number.isSafeInteger(value.timeoutMs)
		|| (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 60_000) {
		throw new Error("invalid browser relay request");
	}
	assertViewId(value.viewId);
	const expectedType = expectedMessageType(value.op);
	if (value.message.type !== expectedType) throw new Error("browser relay operation mismatch");
	if (value.op.startsWith("lifecycle:") && value.message.op !== value.op.slice("lifecycle:".length)) {
		throw new Error("browser relay lifecycle mismatch");
	}
	if (value.op.startsWith("dialogs:") && value.message.op !== value.op.slice("dialogs:".length)) {
		throw new Error("browser relay dialog mismatch");
	}
	if (value.op === "clear-partition") {
		if (value.message.partition !== value.viewId) throw new Error("browser relay partition mismatch");
	} else if (value.message.viewId !== value.viewId) {
		throw new Error("browser relay view mismatch");
	}
}

function expectedMessageType(op: string): string {
	if (op.startsWith("lifecycle:")) return "lax:browser-lifecycle";
	if (op.startsWith("dialogs:")) return "lax:browser-dialogs";
	return `lax:browser-${op}`;
}

function assertViewId(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 512) {
		throw new Error("invalid browser relay view identity");
	}
}

function assertOwnerSessionId(value: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 512) {
		throw new Error("container browser relay owner session is invalid");
	}
}

// Server-side authorization for a relayed request. The relay token only proves
// container MEMBERSHIP, so every op is additionally confined to the container's
// OWN session here — the token by itself would let any in-container code drive
// another session's browser views.
async function authorizeAndRun(
	request: BrowserRelayRequest,
	ownerSessionId: string,
	handler: BrowserRelayHandler,
): Promise<unknown> {
	// clear-partition wipes a whole profile's saved logins, and its target is a
	// `persist:lax-profile-<id>` partition SHARED across every session on that
	// profile — it cannot be confined to one session's views. No in-container
	// caller mints it (browserClearPartition is only reached from the host-side
	// profile-management route), so a container framing it is out of contract.
	if (request.op === "clear-partition") {
		throw new Error("browser relay clear-partition is not available to container sessions");
	}
	// lifecycle:list is a POOL query — the desktop ignores the viewId and returns
	// every session's views (url + title). It can't be gated by a single viewId,
	// so instead the whole-pool reply is filtered down to the caller's own views
	// before it leaves the relay. The list caller (mergeTabs) passes a "*"
	// sentinel viewId, so no per-view ownership assertion applies to this op.
	if (request.op === "lifecycle:list") {
		return filterViewsToSession(await handler.request(request), ownerSessionId);
	}
	// Every other op targets one view (or, for the co-drive `input`/`exec` family,
	// the view named in request.viewId); confine it to a view this session owns.
	assertOwnedView(request.viewId, ownerSessionId);
	return handler.request(request);
}

// Strip other sessions' views out of a pool-list reply so a container never
// learns another session's browsing (url/title). Non-list shapes pass through.
function filterViewsToSession(result: unknown, ownerSessionId: string): unknown {
	if (!isRecord(result) || !Array.isArray(result.views)) return result;
	const views = (result.views as BrowserViewInfo[])
		.filter(view => isRecord(view) && viewBelongsToSession(view.viewId, ownerSessionId));
	return { ...result, views };
}

function assertOwnedView(viewId: string, ownerSessionId: string): void {
	if (!viewBelongsToSession(viewId, ownerSessionId)) {
		throw new Error("browser relay view is not owned by this session");
	}
}

function serializeError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name.slice(0, 128), message: error.message.slice(0, 4_096) }
		: { name: "Error", message: "browser relay request failed" };
}

function removeStaleSocket(path: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || (!stat.isSocket() && process.platform !== "win32")) {
		throw new Error("browser relay path is not a socket");
	}
	rmSync(path, { force: true });
}

function removeOwnedSocket(path: string): void {
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	if (stat.isSocket()) rmSync(path, { force: true });
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => { server.off("error", reject); resolve(); });
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

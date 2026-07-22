import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { sessionIdFromViewId } from "./bridge-perception.js";

export const CONTAINER_BROWSER_RELAY_FLAG = "LAX_CONTAINER_BROWSER_RELAY";
export const CONTAINER_BROWSER_RELAY_SOCKET = "LAX_CONTAINER_BROWSER_RELAY_SOCKET";
export const CONTAINER_BROWSER_RELAY_TOKEN = "LAX_CONTAINER_BROWSER_RELAY_TOKEN";
export const MAX_BROWSER_RELAY_FRAME_BYTES = 16 * 1024 * 1024;

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
	kind: "request" | "abort";
	request?: BrowserRelayRequest;
	viewId?: string;
}

interface RelayFrame {
	version: 1;
	id: string;
	payload: unknown;
	mac: string;
}

interface RelayResponse {
	ok: boolean;
	result?: unknown;
	error?: { name: string; message: string };
}

const ALLOWED_OPS = new Set([
	"lifecycle:create", "lifecycle:show", "lifecycle:hide", "lifecycle:close",
	"lifecycle:setBounds", "lifecycle:ping", "lifecycle:list", "navigate",
	"read-console", "read-network", "dialogs:list", "dialogs:accept",
	"dialogs:dismiss", "exec", "input", "capture", "clear-partition",
]);
const activeServers = new Map<string, BrowserRelayServerHandle>();

export function browserContainerRelayActivated(env = process.env): boolean {
	return env[CONTAINER_BROWSER_RELAY_FLAG] === "1";
}

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
	 *  parsed to a different (or no) session is refused — the token proves only
	 *  container membership, so this is what keeps one container off another
	 *  session's browser views. */
	ownerSessionId: string;
	handler: BrowserRelayHandler;
}): Promise<BrowserRelayServerHandle> {
	validateEndpoint(options.socketPath, options.token);
	assertOwnerSessionId(options.ownerSessionId);
	await activeServers.get(options.socketPath)?.close();
	removeStaleSocket(options.socketPath);
	const sockets = new Set<Socket>();
	const server = createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleSocket(socket, options.token, options.ownerSessionId, options.handler);
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

async function exchange(payload: RelayPayload, timeoutMs: number): Promise<unknown> {
	const { socketPath, token } = configuredEndpoint();
	const frame = sealFrame(payload, token);
	const encoded = encodeFrame(frame);
	const response = await new Promise<RelayResponse>((resolve, reject) => {
		const socket = connect(socketPath);
		let settled = false;
		let bytes = 0;
		let body = "";
		const decoder = new StringDecoder("utf8");
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			fn();
		};
		socket.setTimeout(timeoutMs, () => finish(() => reject(new Error("browser relay timed out"))));
		socket.once("error", error => finish(() => reject(error)));
		socket.once("close", () => finish(() => reject(new Error("browser relay closed before replying"))));
		socket.on("data", chunk => {
			bytes += chunk.length;
			if (bytes > MAX_BROWSER_RELAY_FRAME_BYTES) {
				finish(() => reject(new Error("browser relay response exceeded its limit")));
				return;
			}
			body += decoder.write(chunk);
			const newline = body.indexOf("\n");
			if (newline < 0) return;
			try {
				const reply = verifyFrame(body.slice(0, newline), token, frame.id);
				finish(() => resolve(reply.payload as RelayResponse));
			} catch (error) {
				finish(() => reject(error));
			}
		});
		socket.once("connect", () => socket.write(encoded));
	});
	if (!response.ok) {
		const error = new Error(response.error?.message ?? "browser relay request failed");
		error.name = response.error?.name ?? "Error";
		throw error;
	}
	return response.result;
}

function handleSocket(
	socket: Socket,
	token: string,
	ownerSessionId: string,
	handler: BrowserRelayHandler,
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
		void serveFrame(socket, body.slice(0, newline), token, ownerSessionId, handler);
	});
}

async function serveFrame(
	socket: Socket,
	body: string,
	token: string,
	ownerSessionId: string,
	handler: BrowserRelayHandler,
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
			assertViewOwnership(payload.viewId as string, ownerSessionId);
			await handler.abort(payload.viewId as string);
			response = { ok: true };
		} else {
			const request = payload.request as BrowserRelayRequest;
			assertViewOwnership(request.viewId, ownerSessionId);
			response = { ok: true, result: await handler.request(request) };
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

function sealFrame(payload: unknown, token: string, id: string = randomUUID()): RelayFrame {
	const unsigned = { version: 1 as const, id, payload };
	return { ...unsigned, mac: createHmac("sha256", token).update(JSON.stringify(unsigned)).digest("hex") };
}

function encodeFrame(frame: RelayFrame): string {
	const encoded = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(encoded) > MAX_BROWSER_RELAY_FRAME_BYTES) {
		throw new Error("browser relay frame exceeded its limit");
	}
	return encoded;
}

function verifyFrame(body: string, token: string, expectedId?: string): RelayFrame {
	const frame = JSON.parse(body) as Partial<RelayFrame>;
	if (frame.version !== 1 || typeof frame.id !== "string" || frame.id.length > 64
		|| (expectedId !== undefined && frame.id !== expectedId) || !isRecord(frame.payload)
		|| typeof frame.mac !== "string" || !/^[a-f0-9]{64}$/.test(frame.mac)) {
		throw new Error("invalid browser relay frame");
	}
	const expected = sealFrame(frame.payload, token, frame.id).mac;
	if (!timingSafeEqual(Buffer.from(frame.mac, "hex"), Buffer.from(expected, "hex"))) {
		throw new Error("browser relay authentication failed");
	}
	return frame as RelayFrame;
}

function configuredEndpoint(): { socketPath: string; token: string } {
	if (!browserContainerRelayActivated()) throw new Error("container browser relay is not activated");
	const socketPath = process.env[CONTAINER_BROWSER_RELAY_SOCKET]?.trim() ?? "";
	const token = process.env[CONTAINER_BROWSER_RELAY_TOKEN]?.trim() ?? "";
	validateEndpoint(socketPath, token);
	return { socketPath, token };
}

function validateEndpoint(socketPath: string, token: string): void {
	if (!socketPath || socketPath.length > 512 || !/^[a-f0-9]{64}$/.test(token)) {
		throw new Error("container browser relay configuration is invalid");
	}
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

// Server-side authorization: the relay token only proves container membership,
// so a well-formed, authenticated request must additionally target a view the
// container's OWN session owns. Agent views are named view-<sessionId>-<profile>;
// a viewId whose parsed session differs (cross-session) or is absent (a user /
// foreground view the container never owns) is refused before the handler runs.
function assertViewOwnership(viewId: string, ownerSessionId: string): void {
	if (sessionIdFromViewId(viewId) !== ownerSessionId) {
		throw new Error("browser relay view is not owned by this session");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
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

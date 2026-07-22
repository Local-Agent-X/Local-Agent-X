/**
 * container-bridge-transport — the authenticated, framed request/response
 * transport shared by every container↔host relay client.
 *
 * Two clients now ride this one transport: the browser-op relay
 * (container-bridge-relay.ts, driving views over the host bridge) and the
 * data-lineage forwarder (container-bridge-lineage.ts, pushing the container's
 * taint/canary deltas to the host). Both authenticate every frame with the same
 * per-container HMAC token and speak the same newline-delimited framing, so the
 * crypto/framing/endpoint logic lives here ONCE rather than being duplicated per
 * client. The relay SERVER (which verifies + seals replies) imports the same
 * primitives, so client and server can never drift on the wire format.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";

export const CONTAINER_BROWSER_RELAY_FLAG = "LAX_CONTAINER_BROWSER_RELAY";
export const CONTAINER_BROWSER_RELAY_SOCKET = "LAX_CONTAINER_BROWSER_RELAY_SOCKET";
export const CONTAINER_BROWSER_RELAY_TOKEN = "LAX_CONTAINER_BROWSER_RELAY_TOKEN";
export const MAX_BROWSER_RELAY_FRAME_BYTES = 16 * 1024 * 1024;

export interface RelayFrame {
	version: 1;
	id: string;
	payload: unknown;
	mac: string;
}

export interface RelayResponse {
	ok: boolean;
	result?: unknown;
	error?: { name: string; message: string };
}

export function browserContainerRelayActivated(env = process.env): boolean {
	return env[CONTAINER_BROWSER_RELAY_FLAG] === "1";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sealFrame(payload: unknown, token: string, id: string = randomUUID()): RelayFrame {
	const unsigned = { version: 1 as const, id, payload };
	return { ...unsigned, mac: createHmac("sha256", token).update(JSON.stringify(unsigned)).digest("hex") };
}

export function encodeFrame(frame: RelayFrame): string {
	const encoded = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(encoded) > MAX_BROWSER_RELAY_FRAME_BYTES) {
		throw new Error("browser relay frame exceeded its limit");
	}
	return encoded;
}

export function verifyFrame(body: string, token: string, expectedId?: string): RelayFrame {
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

export function validateEndpoint(socketPath: string, token: string): void {
	if (!socketPath || socketPath.length > 512 || !/^[a-f0-9]{64}$/.test(token)) {
		throw new Error("container browser relay configuration is invalid");
	}
}

function configuredEndpoint(): { socketPath: string; token: string } {
	if (!browserContainerRelayActivated()) throw new Error("container browser relay is not activated");
	const socketPath = process.env[CONTAINER_BROWSER_RELAY_SOCKET]?.trim() ?? "";
	const token = process.env[CONTAINER_BROWSER_RELAY_TOKEN]?.trim() ?? "";
	validateEndpoint(socketPath, token);
	return { socketPath, token };
}

/** Send one authenticated frame to the configured container relay endpoint and
 *  resolve with its verified reply payload's `result` (throwing the remote error
 *  on a not-ok reply). The single client transport for every relay caller. */
export async function exchange(payload: unknown, timeoutMs: number): Promise<unknown> {
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

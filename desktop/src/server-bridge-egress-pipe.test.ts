/**
 * Pipe-transport tests for the egress ask client (server-bridge-egress.ts):
 * a REAL net pipe server stands in for the server's off-loop egress worker.
 * Covers the chunk contract: asks flow over the pipe with zero IPC traffic;
 * killing the pipe mid-flight re-routes the in-flight ask to IPC and later
 * asks stay on IPC until a re-announce; an endpoint re-announce swaps
 * connections cleanly; the bounded in-flight buffer spills overflow to IPC;
 * and a reset (server child respawn) reverts to IPC.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import { createServer, type Server, type Socket } from "net";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

// browser-views drags in the Electron `app` singleton via window.ts/config.ts —
// unavailable under vitest. The ask client only calls viewIdForWebContents.
vi.mock("./browser-views", () => ({ viewIdForWebContents: () => null }));

import {
	askServerEgress,
	resetEgressPipe,
	setEgressPipeEndpoint,
	settleEgressAsk,
	PIPE_INFLIGHT_MAX,
	_egressPipeStateForTest,
} from "./server-bridge-egress";

interface ReceivedAsk { id: number; url: string }

/** In-test stand-in for the egress worker's pipe server: newline-JSON asks in,
 *  optional scripted replies out. */
interface FakeWorkerPipe {
	name: string;
	asks: ReceivedAsk[];
	/** When set, called for each ask (reply through `socket`). */
	respond: ((ask: ReceivedAsk, socket: Socket) => void) | null;
	/** Late-reply every recorded, so-far-unanswered ask on its own socket. */
	replyAll(allowed: boolean): void;
	destroySockets(): void;
	close(): Promise<void>;
}

function makeTestPipeName(): string {
	const nonce = randomBytes(8).toString("hex");
	return process.platform === "win32"
		? `\\\\.\\pipe\\lax-egress-clienttest-${process.pid}-${nonce}`
		: join(tmpdir(), `lax-egress-clienttest-${process.pid}-${nonce}.sock`);
}

const openServers: Server[] = [];

function startFakeWorkerPipe(): Promise<FakeWorkerPipe> {
	const sockets = new Set<Socket>();
	const askSockets = new Map<number, Socket>();
	const fp: FakeWorkerPipe = {
		name: makeTestPipeName(),
		asks: [],
		respond: null,
		replyAll: (allowed) => {
			for (const [id, socket] of askSockets) socket.write(JSON.stringify({ id, allowed }) + "\n");
			askSockets.clear();
		},
		destroySockets: () => { for (const s of sockets) s.destroy(); },
		close: () => new Promise((resolve) => { fp.destroySockets(); server.close(() => resolve()); }),
	};
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setEncoding("utf8");
		let buf = "";
		socket.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim() === "") continue;
				const ask = JSON.parse(line) as ReceivedAsk;
				fp.asks.push(ask);
				if (fp.respond) fp.respond(ask, socket);
				else askSockets.set(ask.id, socket);
			}
		});
	});
	openServers.push(server);
	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(fp.name, () => resolve(fp));
	});
}

interface SentIpcMsg { type: string; id: number; url: string }

function fakeProc() {
	const sent: SentIpcMsg[] = [];
	const proc = {
		connected: true,
		killed: false,
		send: (msg: SentIpcMsg, callback?: (error: Error | null) => void) => {
			sent.push(msg);
			queueMicrotask(() => callback?.(null));
			return true;
		},
	};
	return { proc: proc as unknown as ChildProcess, sent };
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function connectTo(fp: FakeWorkerPipe): Promise<void> {
	setEgressPipeEndpoint(fp.name);
	await waitFor(() => _egressPipeStateForTest().connected, 5000, `pipe connect to ${fp.name}`);
}

const allowReply = (ask: ReceivedAsk, socket: Socket): void => {
	socket.write(JSON.stringify({ id: ask.id, allowed: true }) + "\n");
};

afterEach(async () => {
	resetEgressPipe();
	for (const server of openServers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("egress pipe client — happy path", () => {
	it("asks settle over the pipe with zero IPC traffic (allow and deny)", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = (ask, socket) => {
			socket.write(JSON.stringify({ id: ask.id, allowed: !ask.url.includes("blocked") }) + "\n");
		};
		await connectTo(fp);
		const { proc, sent } = fakeProc();
		await expect(askServerEgress(proc, { url: "https://example.com/" } as never)).resolves.toEqual({ allowed: true });
		await expect(askServerEgress(proc, { url: "https://blocked.example/" } as never)).resolves.toEqual({ allowed: false });
		expect(sent).toHaveLength(0); // never touched the in-loop IPC path
		expect(fp.asks.map((a) => a.url)).toEqual(["https://example.com/", "https://blocked.example/"]);
	});

	it("a reply for an unknown id is ignored; the real reply still settles the ask", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = (ask, socket) => {
			socket.write(JSON.stringify({ id: ask.id + 9999, allowed: false }) + "\n"); // stray
			socket.write(JSON.stringify({ id: ask.id, allowed: true }) + "\n");
		};
		await connectTo(fp);
		const { proc, sent } = fakeProc();
		await expect(askServerEgress(proc, { url: "https://example.com/" } as never)).resolves.toEqual({ allowed: true });
		expect(sent).toHaveLength(0);
		expect(_egressPipeStateForTest().connected).toBe(true); // stray id ≠ protocol violation
	});
});

describe("egress pipe client — mid-flight death and recovery", () => {
	it("re-routes the in-flight ask to IPC, keeps later asks on IPC, then swaps to a re-announced pipe", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = null; // hold every ask un-answered
		await connectTo(fp);
		const { proc, sent } = fakeProc();

		const inflight = askServerEgress(proc, { url: "https://a.example/" } as never);
		await waitFor(() => fp.asks.length === 1, 5000, "ask to reach the pipe");
		expect(sent).toHaveLength(0);

		// Kill the pipe under the in-flight ask: it must re-route to IPC with
		// the SAME id (no deny from the connection error itself).
		await fp.close();
		await waitFor(() => sent.length === 1, 5000, "in-flight ask re-routed to IPC");
		expect(sent[0].type).toBe("lax:browser-egress-ask");
		expect(sent[0].url).toBe("https://a.example/");
		settleEgressAsk(sent[0].id, true);
		await expect(inflight).resolves.toEqual({ allowed: true });

		// Pipe is down → later asks use IPC.
		const next = askServerEgress(proc, { url: "https://b.example/" } as never);
		await waitFor(() => sent.length === 2, 5000, "follow-up ask over IPC");
		settleEgressAsk(sent[1].id, false);
		await expect(next).resolves.toEqual({ allowed: false });

		// Re-announce (worker restarted on a fresh name) → asks flow over the
		// new pipe again, IPC untouched.
		const fp2 = await startFakeWorkerPipe();
		fp2.respond = allowReply;
		await connectTo(fp2);
		await expect(askServerEgress(proc, { url: "https://c.example/" } as never)).resolves.toEqual({ allowed: true });
		expect(fp2.asks.map((a) => a.url)).toEqual(["https://c.example/"]);
		expect(sent).toHaveLength(2);
	});

	it("a malformed reply drops the connection and falls back to IPC for that ask", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = (_ask, socket) => socket.write("not-json\n");
		await connectTo(fp);
		const { proc, sent } = fakeProc();
		const ask = askServerEgress(proc, { url: "https://example.com/" } as never);
		await waitFor(() => sent.length === 1, 5000, "malformed-reply fallback to IPC");
		settleEgressAsk(sent[0].id, true);
		await expect(ask).resolves.toEqual({ allowed: true });
		// (connected-state not asserted here: the client legitimately re-tries
		// the still-listening endpoint on its own backoff.)
	});

	it("an endpoint re-announce swaps connections cleanly while both pipes are up", async () => {
		const fp1 = await startFakeWorkerPipe();
		fp1.respond = allowReply;
		await connectTo(fp1);
		const { proc, sent } = fakeProc();
		await expect(askServerEgress(proc, { url: "https://one.example/" } as never)).resolves.toEqual({ allowed: true });

		const fp2 = await startFakeWorkerPipe();
		fp2.respond = (ask, socket) => socket.write(JSON.stringify({ id: ask.id, allowed: false }) + "\n");
		await connectTo(fp2);
		await expect(askServerEgress(proc, { url: "https://two.example/" } as never)).resolves.toEqual({ allowed: false });
		expect(fp1.asks.map((a) => a.url)).toEqual(["https://one.example/"]); // old pipe saw nothing new
		expect(fp2.asks.map((a) => a.url)).toEqual(["https://two.example/"]);
		expect(sent).toHaveLength(0);
	});
});

describe("egress pipe client — bounds and reset", () => {
	it("in-flight overflow past the cap spills to IPC (never buffers unbounded)", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = null; // hold replies so asks accumulate in-flight
		await connectTo(fp);
		const { proc, sent } = fakeProc();

		const held = Array.from({ length: PIPE_INFLIGHT_MAX }, (_, i) =>
			askServerEgress(proc, { url: `https://held.example/${i}` } as never));
		await waitFor(() => fp.asks.length === PIPE_INFLIGHT_MAX, 10_000, "cap-many asks on the pipe");
		expect(sent).toHaveLength(0);
		expect(_egressPipeStateForTest().inflight).toBe(PIPE_INFLIGHT_MAX);

		// One past the cap → IPC, not the pipe.
		const overflow = askServerEgress(proc, { url: "https://overflow.example/" } as never);
		await waitFor(() => sent.length === 1, 5000, "overflow ask over IPC");
		expect(fp.asks).toHaveLength(PIPE_INFLIGHT_MAX);
		settleEgressAsk(sent[0].id, true);
		await expect(overflow).resolves.toEqual({ allowed: true });

		// Drain: late pipe replies settle every held ask.
		fp.replyAll(true);
		await expect(Promise.all(held)).resolves.toEqual(
			Array.from({ length: PIPE_INFLIGHT_MAX }, () => ({ allowed: true })),
		);
	}, 30_000);

	it("resetEgressPipe (server child respawn) reverts asks to IPC immediately", async () => {
		const fp = await startFakeWorkerPipe();
		fp.respond = allowReply;
		await connectTo(fp);
		resetEgressPipe();
		expect(_egressPipeStateForTest()).toEqual({ endpoint: null, connected: false, inflight: 0 });
		const { proc, sent } = fakeProc();
		const ask = askServerEgress(proc, { url: "https://after-reset.example/" } as never);
		await waitFor(() => sent.length === 1, 5000, "post-reset ask over IPC");
		settleEgressAsk(sent[0].id, true);
		await expect(ask).resolves.toEqual({ allowed: true });
		expect(fp.asks).toHaveLength(0);
	});
});

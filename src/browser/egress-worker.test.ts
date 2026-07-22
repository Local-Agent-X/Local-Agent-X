/**
 * End-to-end tests for the off-loop egress worker (egress-worker.ts +
 * egress-worker-host.ts): a REAL worker thread serving a REAL named pipe,
 * evaluated against a temp LAX_DATA_DIR — no mocks of anything under test.
 *
 * Covers the chunk's contract: pipe/fallback decision parity, mirror-fed
 * taint/canary denies, stall immunity (replies while the main thread is
 * blocked), fail-closed pipe errors + crash restart with a fresh endpoint,
 * and the worker-deny → main-thread peekEgressDeny reason round trip.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { Worker } from "node:worker_threads";

import { startEgressWorkerHost, stopEgressWorkerHost, currentEgressEndpoint, _crashEgressWorkerForTest } from "./egress-worker-host.js";
import { answerEgressAsk, peekEgressDeny, type EgressAskMessage } from "./bridge-egress.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries } from "../threat/canaries.js";

const TAINT_SESSION = "wrk-taint-sess";
const TAINT_VIEW = `view-${TAINT_SESSION}-default`;
const CANARY_SESSION = "wrk-canary-sess";
const CANARY_VIEW = `view-${CANARY_SESSION}-default`;
// >= fingerprint shingle width so the recorded read produces overlap evidence.
const SECRET = "wrk_secret_access_key_0f9e8d7c6b5a4321ffeeddccbbaa";

let laxDir: string;
const endpoints: string[] = [];
let nextId = 1;

const originalSend = process.send;
const sentReplies: Array<{ type: string; id: number; allowed: boolean }> = [];

function pipe(): string {
	const ep = endpoints[endpoints.length - 1];
	expect(ep).toBeTruthy();
	return ep;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** One ask over the pipe. Client-side fail-closed contract: any connection /
 *  protocol error resolves { allowed: false } (never throws, never hangs). */
function askPipe(pipeName: string, ask: Omit<EgressAskMessage, "id">, timeoutMs = 5000): Promise<{ allowed: boolean; error?: string }> {
	const id = nextId++;
	return new Promise((resolve) => {
		const socket = connect(pipeName);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve({ allowed: false, error: "timeout" });
		}, timeoutMs);
		let buf = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(JSON.stringify({ id, ...ask }) + "\n"));
		socket.on("data", (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			socket.end();
			try {
				const reply = JSON.parse(buf.slice(0, nl)) as { id: number; allowed: boolean };
				resolve({ allowed: reply.id === id && reply.allowed === true });
			} catch {
				resolve({ allowed: false, error: "bad reply" });
			}
		});
		socket.on("error", (e) => {
			clearTimeout(timer);
			resolve({ allowed: false, error: e.message });
		});
	});
}

/** The same ask through the in-loop fallback (answerEgressAsk). */
function askFallback(ask: Omit<EgressAskMessage, "id">): boolean {
	const id = nextId++;
	answerEgressAsk({ id, ...ask });
	const reply = sentReplies.find((m) => m.type === "lax:browser-egress-ask-result" && m.id === id);
	expect(reply).toBeTruthy();
	return reply!.allowed === true;
}

beforeAll(async () => {
	laxDir = mkdtempSync(join(tmpdir(), "lax-egress-worker-test-"));
	process.env.LAX_DATA_DIR = laxDir; // worker inherits env at spawn
	process.env.LAX_PORT = "7007";
	process.send = ((msg: unknown) => {
		sentReplies.push(msg as { type: string; id: number; allowed: boolean });
		return true;
	}) as typeof process.send;

	startEgressWorkerHost((pipeName) => endpoints.push(pipeName));
	await waitFor(() => endpoints.length >= 1, 30_000, "first worker endpoint");
}, 40_000);

afterAll(async () => {
	await stopEgressWorkerHost();
	process.send = originalSend;
	clearSessionTaint(TAINT_SESSION);
	clearSessionCanaries(CANARY_SESSION);
	delete process.env.LAX_DATA_DIR;
	delete process.env.LAX_PORT;
	rmSync(laxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("egress worker — pipe vs in-loop fallback parity", () => {
	it("announces its endpoint through the host", () => {
		expect(currentEgressEndpoint()).toBe(pipe());
		expect(pipe()).toContain("lax-egress-");
	});

	it("allows a public URL on both paths", async () => {
		const viaPipe = await askPipe(pipe(), { url: "https://example.com/" });
		expect(viaPipe.error).toBeUndefined();
		expect(viaPipe.allowed).toBe(true);
		expect(askFallback({ url: "https://example.com/" })).toBe(true);
	});

	it("denies a blocked hostname (SSRF) on both paths", async () => {
		const viaPipe = await askPipe(pipe(), { url: "http://169.254.169.254/latest/meta-data/" });
		expect(viaPipe.allowed).toBe(false);
		expect(askFallback({ url: "http://169.254.169.254/latest/meta-data/" })).toBe(false);
	});

	it("denies malformed URLs on both paths", async () => {
		expect((await askPipe(pipe(), { url: "not a url" })).allowed).toBe(false);
		expect(askFallback({ url: "not a url" })).toBe(false);
	});

	it("applies strict-mode allowlist config from disk on both paths", async () => {
		writeFileSync(join(laxDir, "egress-allowlist.json"), JSON.stringify(["allowed.example"]), "utf-8");
		writeFileSync(join(laxDir, "security.json"), JSON.stringify({ egressMode: "strict" }), "utf-8");
		try {
			expect((await askPipe(pipe(), { url: "https://allowed.example/ok" })).allowed).toBe(true);
			expect(askFallback({ url: "https://allowed.example/ok" })).toBe(true);
			expect((await askPipe(pipe(), { url: "https://blocked.example/no" })).allowed).toBe(false);
			expect(askFallback({ url: "https://blocked.example/no" })).toBe(false);
		} finally {
			unlinkSync(join(laxDir, "egress-allowlist.json"));
			unlinkSync(join(laxDir, "security.json"));
		}
		// The worker's mtime-keyed config cache must observe the removal too.
		expect((await askPipe(pipe(), { url: "https://blocked.example/no" })).allowed).toBe(true);
		expect(askFallback({ url: "https://blocked.example/no" })).toBe(true);
	});

	it("denies a cross-domain request carrying tainted bytes once the mirror catches up (and in-loop agrees)", async () => {
		recordSensitiveRead(TAINT_SESSION, "sensitive_file", "/tmp/secret.env", SECRET);
		const ask = {
			url: `https://evil.example/collect?d=${SECRET}`,
			pageUrl: "https://myapp.example/",
			viewId: TAINT_VIEW,
		};
		// Mirror delivery is eventually-consistent — poll until the deny lands.
		const deadline = Date.now() + 5000;
		let allowed = true;
		while (allowed && Date.now() < deadline) {
			allowed = (await askPipe(pipe(), ask)).allowed;
			if (allowed) await new Promise((r) => setTimeout(r, 50));
		}
		expect(allowed).toBe(false);
		expect(askFallback(ask)).toBe(false);
		// Same session, cross-domain, but CLEAN payload → rendering survives.
		const clean = { url: "https://cdn.example/app.js", pageUrl: "https://myapp.example/", viewId: TAINT_VIEW };
		expect((await askPipe(pipe(), clean)).allowed).toBe(true);
		expect(askFallback(clean)).toBe(true);
	});

	it("denies a cross-domain request carrying the session canary on both paths", async () => {
		const canaries = generateCanaries();
		registerSessionCanaries(CANARY_SESSION, canaries);
		const ask = {
			url: "https://exfil.example/beacon",
			pageUrl: "https://myapp.example/",
			body: `payload=${canaries[0]}`,
			viewId: CANARY_VIEW,
		};
		const deadline = Date.now() + 5000;
		let allowed = true;
		while (allowed && Date.now() < deadline) {
			allowed = (await askPipe(pipe(), ask)).allowed;
			if (allowed) await new Promise((r) => setTimeout(r, 50));
		}
		expect(allowed).toBe(false);
		expect(askFallback(ask)).toBe(false);
	});
});

describe("egress worker — deny-reason round trip", () => {
	it("a worker deny surfaces via peekEgressDeny on the main thread", async () => {
		const url = "http://169.254.169.254/roundtrip";
		const viewId = "view-roundtrip-sess-default";
		expect((await askPipe(pipe(), { url, viewId })).allowed).toBe(false);
		// The worker posts the deny to the host asynchronously; allow it to settle.
		await waitFor(() => peekEgressDeny(url, viewId) !== null, 5000, "deny to reach the main-thread cache");
		expect(peekEgressDeny(url, viewId)?.reason).toContain("private/reserved IPv4 address");
	});
});

describe("egress worker — stall immunity", () => {
	it("answers on the pipe while the main thread is blocked for ~2s", async () => {
		// The pipe client must live OFF the main thread (which we're about to
		// block), so a tiny eval-worker sends the ask and timestamps the reply.
		const helper = new Worker(
			`
			const { parentPort, workerData } = require("node:worker_threads");
			const net = require("node:net");
			parentPort.postMessage({ armed: true });
			parentPort.once("message", () => {
				const started = Date.now();
				const s = net.connect(workerData.pipeName);
				let buf = "";
				s.setEncoding("utf8");
				s.on("connect", () => s.write(JSON.stringify({ id: 1, url: workerData.url }) + "\\n"));
				s.on("data", (c) => {
					buf += c;
					if (buf.includes("\\n")) {
						parentPort.postMessage({ replyAt: Date.now(), elapsedMs: Date.now() - started, reply: JSON.parse(buf.split("\\n")[0]) });
						s.end();
					}
				});
				s.on("error", (e) => parentPort.postMessage({ error: e.message }));
			});
			`,
			{ eval: true, workerData: { pipeName: pipe(), url: "https://example.com/stall" } },
		);
		interface HelperResult { armed?: boolean; error?: string; replyAt?: number; elapsedMs?: number; reply?: { allowed: boolean } }
		let result: HelperResult | null = null;
		const armed = new Promise<void>((resolve) => {
			helper.on("message", (m: HelperResult) => {
				if (m.armed) resolve();
				else result = m;
			});
		});
		await armed;
		helper.postMessage("go");
		// Synchronously starve the main event loop — the exact condition that
		// used to hang every in-loop egress ask for the stall's duration.
		const blockStart = Date.now();
		while (Date.now() - blockStart < 2000) { /* busy */ }
		const blockEnd = Date.now();
		await waitFor(() => result !== null, 5000, "helper reply");
		await helper.terminate();
		const r = result! as HelperResult;
		expect(r.error).toBeUndefined();
		expect(r.reply?.allowed).toBe(true);
		expect(r.elapsedMs!).toBeLessThan(1000); // answered well inside the stall
		expect(r.replyAt!).toBeLessThan(blockEnd); // ...i.e. WHILE main was blocked
	});
});

describe("egress worker — crash: fail closed, restart, re-announce", () => {
	it("dead pipe asks resolve deny; the host restarts on a FRESH endpoint that answers", async () => {
		const before = endpoints.length;
		const oldPipe = pipe();
		await _crashEgressWorkerForTest();
		// Old endpoint is gone → the client-side contract turns the error into a deny.
		const dead = await askPipe(oldPipe, { url: "https://example.com/" }, 2000);
		expect(dead.allowed).toBe(false);
		expect(dead.error).toBeTruthy();
		// Bounded-backoff restart announces a NEW pipe name...
		await waitFor(() => endpoints.length > before, 15_000, "restart endpoint announce");
		expect(pipe()).not.toBe(oldPipe);
		expect(currentEgressEndpoint()).toBe(pipe());
		// ...and the fresh worker serves the same decisions.
		expect((await askPipe(pipe(), { url: "https://example.com/" })).allowed).toBe(true);
		expect((await askPipe(pipe(), { url: "http://169.254.169.254/" })).allowed).toBe(false);
	}, 30_000);
});

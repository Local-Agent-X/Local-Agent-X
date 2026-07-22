import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONTAINER_BROWSER_RELAY_FLAG,
	CONTAINER_BROWSER_RELAY_SOCKET,
	CONTAINER_BROWSER_RELAY_TOKEN,
	startBrowserContainerRelay,
	type BrowserRelayServerHandle,
} from "./container-bridge-relay.js";
import { relayForwardCanaries, relayForwardTaint } from "./container-bridge-lineage.js";
import { startContainerLineageForwarding } from "./container-taint-forward.js";
import { sessionBelongsToSession } from "./bridge-perception.js";
import { scanPageEgress } from "./page-egress-taint.js";
import { computeFingerprints, type TaintEntry } from "../data-lineage/fingerprint.js";
import {
	clearSessionTaint,
	findTaintInPayload,
	recordSensitiveRead,
	setForwardedSessionTaint,
} from "../data-lineage/index.js";
import { clearSessionCanaries, registerSessionCanaries } from "../threat/canaries.js";

const token = "a".repeat(64);
const OWNER = "sess-owner-1";
// A secret long enough (> the fingerprint shingle width) to fingerprint.
const SECRET = "SECRETKEY_abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFGHIJKL";
const OTHER_SECRET = "OTHERKEY_zyxwvutsrqponmlkjihgfedcba9876543210_ZYXWVUTSRQ";
const CANARY = "CANARY-deadbeefcafe1234-ALPHA";
const PAGE_URL = "https://app.example.com/home";
const CROSS_URL = "https://evil.example.net/collect";

const handles: BrowserRelayServerHandle[] = [];
const stops: Array<() => void> = [];
const touchedSessions = new Set<string>();
const original = {
	flag: process.env[CONTAINER_BROWSER_RELAY_FLAG],
	socket: process.env[CONTAINER_BROWSER_RELAY_SOCKET],
	token: process.env[CONTAINER_BROWSER_RELAY_TOKEN],
};

function endpoint(name: string): string {
	return process.platform === "win32"
		? `\\\\.\\pipe\\lax-lineage-${process.pid}-${name}`
		: join(tmpdir(), `lax-lineage-${process.pid}-${name}.sock`);
}

function activate(socketPath: string, secret = token): void {
	process.env[CONTAINER_BROWSER_RELAY_FLAG] = "1";
	process.env[CONTAINER_BROWSER_RELAY_SOCKET] = socketPath;
	process.env[CONTAINER_BROWSER_RELAY_TOKEN] = secret;
}

/** A taint entry as a container would forward it — fingerprints of `secret`,
 *  computed WITHOUT touching any registry. */
function taintEntry(sessionId: string, secret: string): TaintEntry {
	const fp = computeFingerprints(secret);
	return { source: "sensitive_file", target: "/work/.env", timestamp: Date.now(), runId: sessionId, fingerprints: fp.fingerprints, complete: fp.complete };
}

/** A cross-registrable-domain page request whose body carries `payload`. */
function crossHopCarrying(payload: string) {
	return { url: CROSS_URL, pageUrl: PAGE_URL, body: payload };
}

type SpySink = {
	applyTaint: ReturnType<typeof vi.fn<(sessionId: string, entries: TaintEntry[]) => void>>;
	applyCanaries: ReturnType<typeof vi.fn<(sessionId: string, canaries: string[]) => void>>;
};

function spySink(): SpySink {
	return {
		applyTaint: vi.fn<(sessionId: string, entries: TaintEntry[]) => void>(),
		applyCanaries: vi.fn<(sessionId: string, canaries: string[]) => void>(),
	};
}

async function startRelay(ownerSessionId: string, opts?: { realHostSink?: boolean; sink?: SpySink }): Promise<{ handle: BrowserRelayServerHandle; sink?: SpySink }> {
	const socketPath = endpoint(ownerSessionId + "-" + Math.random().toString(36).slice(2, 8));
	const lineage = opts?.sink
		? opts.sink
		: opts?.realHostSink
			? { applyTaint: setForwardedSessionTaint, applyCanaries: registerSessionCanaries }
			: undefined;
	const handle = await startBrowserContainerRelay({
		socketPath,
		token,
		ownerSessionId,
		handler: { request: vi.fn(), abort: vi.fn() },
		lineage,
	});
	handles.push(handle);
	activate(socketPath);
	return { handle, sink: opts?.sink };
}

beforeEach(() => {
	for (const s of [OWNER, "sess-owner-2", "sess-victim", `${OWNER}-b0`]) {
		clearSessionTaint(s);
		clearSessionCanaries(s);
		touchedSessions.add(s);
	}
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	await Promise.all(handles.splice(0).map(h => h.close()));
	for (const s of touchedSessions) { clearSessionTaint(s); clearSessionCanaries(s); }
	touchedSessions.clear();
	for (const [key, value] of Object.entries(original)) {
		const envKey = key === "flag" ? CONTAINER_BROWSER_RELAY_FLAG
			: key === "socket" ? CONTAINER_BROWSER_RELAY_SOCKET : CONTAINER_BROWSER_RELAY_TOKEN;
		if (value === undefined) delete process.env[envKey];
		else process.env[envKey] = value;
	}
});

describe("container lineage forwarding → host page-egress scan", () => {
	it("blocks a container's tainted cross-domain page request once its taint is forwarded", async () => {
		touchedSessions.add(OWNER);
		await startRelay(OWNER, { realHostSink: true });

		// WOULD-FAIL-BEFORE: the host registry is empty for the container session,
		// so the exfil request is waved through — the exact blind spot.
		expect(scanPageEgress(OWNER, crossHopCarrying(SECRET))).toEqual({ allowed: true });

		await relayForwardTaint(OWNER, [taintEntry(OWNER, SECRET)]);

		const verdict = scanPageEgress(OWNER, crossHopCarrying(SECRET));
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) expect(verdict.layer).toBe("data-lineage");
	});

	it("blocks a forwarded session canary appearing in a cross-domain request", async () => {
		touchedSessions.add(OWNER);
		await startRelay(OWNER, { realHostSink: true });

		expect(scanPageEgress(OWNER, crossHopCarrying(CANARY))).toEqual({ allowed: true });

		await relayForwardCanaries(OWNER, [CANARY]);

		const verdict = scanPageEgress(OWNER, crossHopCarrying(CANARY));
		expect(verdict.allowed).toBe(false);
		if (!verdict.allowed) {
			expect(verdict.layer).toBe("canary");
			expect(verdict.canary).toBe(true);
		}
	});

	it("allows a clean container request whose payload does not overlap the forwarded taint", async () => {
		touchedSessions.add(OWNER);
		await startRelay(OWNER, { realHostSink: true });
		await relayForwardTaint(OWNER, [taintEntry(OWNER, SECRET)]);

		// Positive-overlap-only preserved: a cross-domain request carrying an
		// UNRELATED secret's bytes is not exfil of the tainted source.
		expect(scanPageEgress(OWNER, crossHopCarrying(OTHER_SECRET))).toEqual({ allowed: true });
	});

	it("admits taint forwarded for the owner's own hyphen-nested descendant session", async () => {
		const descendant = `${OWNER}-b0`;
		touchedSessions.add(descendant);
		await startRelay(OWNER, { realHostSink: true });

		await relayForwardTaint(descendant, [taintEntry(descendant, SECRET)]);

		const verdict = scanPageEgress(descendant, crossHopCarrying(SECRET));
		expect(verdict.allowed).toBe(false);
	});
});

describe("cross-session forwarding is rejected (finding-4 binding holds)", () => {
	it("refuses taint a container forwards for a DIFFERENT session and leaves that session clean", async () => {
		const victim = "sess-victim";
		touchedSessions.add(victim);
		// Relay owned by OWNER; the container tries to poison `victim`.
		await startRelay(OWNER, { realHostSink: true });

		await expect(relayForwardTaint(victim, [taintEntry(victim, SECRET)]))
			.rejects.toThrow("not owned by this session");

		// The victim session's host registry was never touched → still allowed.
		expect(findTaintInPayload(victim, SECRET)).toEqual([]);
		expect(scanPageEgress(victim, crossHopCarrying(SECRET))).toEqual({ allowed: true });
	});

	it("refuses a sibling-prefixed session (s1 must not own s12-style ids)", async () => {
		await startRelay("s1", { realHostSink: true });
		touchedSessions.add("s12");
		await expect(relayForwardTaint("s12", [taintEntry("s12", SECRET)]))
			.rejects.toThrow("not owned by this session");
		expect(findTaintInPayload("s12", SECRET)).toEqual([]);
	});
});

describe("container-side forwarder wiring", () => {
	it("forwards a sensitive read to the host as it accrues", async () => {
		const sink = spySink();
		// The container's agent-loop session IS the relay's owning session, so its
		// forwarded taint passes the host session-binding.
		const session = OWNER;
		touchedSessions.add(session);
		clearSessionTaint(session);
		await startRelay(OWNER, { sink });

		const stop = startContainerLineageForwarding();
		stops.push(stop);

		recordSensitiveRead(session, "sensitive_file", "/work/.env", SECRET);

		await vi.waitFor(() => expect(sink.applyTaint).toHaveBeenCalled());
		const call = sink.applyTaint.mock.calls.find(c => c[0] === session);
		expect(call).toBeDefined();
		expect(call![1][0].fingerprints.length).toBeGreaterThan(0);
	});

	it("is a no-op when the browser relay is not activated", () => {
		delete process.env[CONTAINER_BROWSER_RELAY_FLAG];
		delete process.env[CONTAINER_BROWSER_RELAY_SOCKET];
		delete process.env[CONTAINER_BROWSER_RELAY_TOKEN];
		const stop = startContainerLineageForwarding();
		expect(typeof stop).toBe("function");
		stop(); // detaches nothing, must not throw
	});
});

describe("sessionBelongsToSession boundary", () => {
	it("admits the exact session and hyphen-nested descendants, rejects siblings and foreigners", () => {
		expect(sessionBelongsToSession("s1", "s1")).toBe(true);
		expect(sessionBelongsToSession("s1-b0", "s1")).toBe(true);
		expect(sessionBelongsToSession("s12", "s1")).toBe(false);
		expect(sessionBelongsToSession("s2", "s1")).toBe(false);
		expect(sessionBelongsToSession("", "s1")).toBe(false);
		expect(sessionBelongsToSession("s1", "")).toBe(false);
	});
});

describe("setForwardedSessionTaint host ingest semantics", () => {
	it("replaces a session's taint and clears on an empty forward", () => {
		const session = "sess-ingest-1";
		touchedSessions.add(session);
		setForwardedSessionTaint(session, [taintEntry(session, SECRET)]);
		expect(findTaintInPayload(session, SECRET).length).toBeGreaterThan(0);

		// A later full-state delta REPLACES: forwarding OTHER_SECRET's entry drops
		// the SECRET overlap.
		setForwardedSessionTaint(session, [taintEntry(session, OTHER_SECRET)]);
		expect(findTaintInPayload(session, SECRET)).toEqual([]);
		expect(findTaintInPayload(session, OTHER_SECRET).length).toBeGreaterThan(0);

		// Empty → cleared.
		setForwardedSessionTaint(session, []);
		expect(findTaintInPayload(session, OTHER_SECRET)).toEqual([]);
	});
});

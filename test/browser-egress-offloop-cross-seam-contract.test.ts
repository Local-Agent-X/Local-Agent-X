/**
 * Cross-seam contract for the off-loop egress decision.
 *
 * The browser-reliability campaign moved in-app page-request approval off the
 * server's busy event loop: a worker thread now answers egress asks over a pipe
 * instead of the in-loop process.on("message") handler. Both paths MUST reach an
 * identical decision — the worker just runs the same core (decideEgressAsk) with
 * mirrored registries and a cached config instead of the live module state.
 *
 * This proves the seam holds: the same asks, fed through an in-loop-style deps
 * bundle and a worker-style deps bundle, produce byte-identical outcomes across
 * the four decision classes (allow, URL-policy deny, taint deny, canary deny) —
 * including the fail-open vs fail-closed asymmetry the two layers are defined to
 * have. It then proves a deny outcome round-trips to peekEgressDeny, the seam the
 * renderer error card reads to name the block for the user.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	decideEgressAsk,
	recordEgressDeny,
	peekEgressDeny,
	clearEgressDeny,
	type EgressAskDeps,
	type EgressAskMessage,
} from "../src/browser/bridge-egress.js";
import type { PageEgressRequest, PageEgressVerdict } from "../src/browser/page-egress-taint.js";
import type { SecurityDecision } from "../src/types.js";

// A deterministic policy shared by both dep bundles so any divergence is the
// SEAM's, not the inputs': block one host, taint one session's byte, canary
// another. The "in-loop" and "worker" bundles differ only in HOW they resolve
// these (live module reads vs mirrored copies) — modeled here as two closures
// over the same rule table, exactly the split decideEgressAsk is designed for.
const RULES = {
	blockedHost: "blocked.example",
	taintSession: "sess-taint",
	taintByte: "SECRET_TOKEN_ABC",
	canarySession: "sess-canary",
	canaryByte: "CANARY_ZZZ",
};

function evaluateUrl(url: string): SecurityDecision {
	const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
	if (host === RULES.blockedHost) {
		return { allowed: false, reason: `Blocked: ${host} is not allowed`, recovery: "add it to the allowlist" };
	}
	return { allowed: true, reason: "ok" };
}

function scan(sessionId: string, req: PageEgressRequest): PageEgressVerdict {
	const hay = `${req.url}\n${req.body ?? ""}`;
	if (sessionId === RULES.canarySession && hay.includes(RULES.canaryByte)) {
		return { allowed: false, layer: "canary", canary: true, reason: `canary in request to ${new URL(req.url).hostname}` };
	}
	if (sessionId === RULES.taintSession && hay.includes(RULES.taintByte)) {
		return { allowed: false, layer: "data-lineage", canary: false, reason: `tainted bytes to ${new URL(req.url).hostname}` };
	}
	return { allowed: true };
}

// In-loop bundle: resolves the session straight from the viewId (the module's
// sessionIdFromViewId behavior — "view-<sid>-default").
const inLoopDeps: EgressAskDeps = {
	evaluateUrl,
	sessionForView: (viewId) => {
		const m = /^view-(.+)-[^-]+$/.exec(viewId);
		return m ? m[1] : undefined;
	},
	scan,
};

// Worker bundle: the worker cannot see the live registries, so it resolves the
// session from a MIRROR the host streamed in. Same answers, different source —
// the exact substitution the off-loop move makes.
const mirror = new Map<string, string>([
	["view-sess-taint-default", "sess-taint"],
	["view-sess-canary-default", "sess-canary"],
	["view-sess-plain-default", "sess-plain"],
]);
const workerDeps: EgressAskDeps = {
	evaluateUrl, // pure + config-driven → identical in the worker
	sessionForView: (viewId) => mirror.get(viewId),
	scan, // page-egress scan is pure over injected state
};

const CASES: { name: string; ask: EgressAskMessage }[] = [
	{ name: "allow: clean cross-site read, attributed view", ask: { id: 1, url: "https://cdn.example/app.js", viewId: "view-sess-plain-default" } },
	{ name: "allow: unattributable view → URL policy only", ask: { id: 2, url: "https://api.example/x", viewId: "view-unknown" } },
	{ name: "deny: URL/SSRF policy (fail-closed)", ask: { id: 3, url: "https://blocked.example/beacon", viewId: "view-sess-plain-default" } },
	{ name: "deny: tainted bytes in body", ask: { id: 4, url: "https://evil.example/up", body: "x=SECRET_TOKEN_ABC", viewId: "view-sess-taint-default" } },
	{ name: "allow: same session, clean body (positive-overlap only)", ask: { id: 5, url: "https://evil.example/up", body: "x=harmless", viewId: "view-sess-taint-default" } },
	{ name: "deny: canary in URL", ask: { id: 6, url: "https://exfil.example/?t=CANARY_ZZZ", viewId: "view-sess-canary-default" } },
];

describe("off-loop egress decision cross-seam contract", () => {
	it.each(CASES)("in-loop and worker paths agree — $name", ({ ask }) => {
		const inLoop = decideEgressAsk(ask, inLoopDeps);
		const worker = decideEgressAsk(ask, workerDeps);
		expect(worker.allowed).toBe(inLoop.allowed);
		expect(worker.deny?.reason).toBe(inLoop.deny?.reason);
		expect(worker.deny?.recovery).toBe(inLoop.deny?.recovery);
		expect(Boolean(worker.canarySessionId)).toBe(Boolean(inLoop.canarySessionId));
	});

	it("a URL-policy deny fails CLOSED and names a reason", () => {
		const out = decideEgressAsk({ id: 7, url: "https://blocked.example/x", viewId: "view-sess-plain-default" }, inLoopDeps);
		expect(out.allowed).toBe(false);
		expect(out.deny?.reason).toContain("blocked.example");
	});

	it("a page-egress SCAN error fails OPEN (URL policy already passed)", () => {
		const throwingScan: EgressAskDeps = { ...inLoopDeps, scan: () => { throw new Error("scan bug"); } };
		const out = decideEgressAsk({ id: 8, url: "https://ok.example/x", viewId: "view-sess-plain-default" }, throwingScan);
		expect(out.allowed).toBe(true);
	});

	it("a URL-evaluator error fails CLOSED", () => {
		const throwingUrl: EgressAskDeps = { ...inLoopDeps, evaluateUrl: () => { throw new Error("policy bug"); } };
		const out = decideEgressAsk({ id: 9, url: "https://ok.example/x", viewId: "view-sess-plain-default" }, throwingUrl);
		expect(out.allowed).toBe(false);
	});
});

describe("deny reason round-trips to the renderer error-card seam", () => {
	const url = "https://blocked.example/beacon";
	const viewId = "view-sess-plain-default";
	beforeEach(() => clearEgressDeny(url, viewId));

	it("a recorded deny is readable by peekEgressDeny without consuming it", () => {
		const out = decideEgressAsk({ id: 10, url, viewId }, inLoopDeps);
		expect(out.allowed).toBe(false);
		// The caller (in-loop answerer, or the worker host on a posted deny) records it.
		recordEgressDeny(url, viewId, out.deny!.reason, out.deny!.recovery);
		// The error card fetches it — and a second fetch still sees it (non-consuming),
		// because the human may re-open the page before the agent's consuming read.
		expect(peekEgressDeny(url, viewId)?.reason).toBe(out.deny!.reason);
		expect(peekEgressDeny(url, viewId)?.reason).toBe(out.deny!.reason);
		expect(peekEgressDeny(url, viewId)?.recovery).toBe(out.deny!.recovery);
	});
});

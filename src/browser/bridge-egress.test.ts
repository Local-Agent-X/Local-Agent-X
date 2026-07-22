import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../security/layer/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../security/layer/index.js")>();
	return { ...actual, evaluateEgressForUrl: vi.fn() };
});
vi.mock("./page-egress-taint.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./page-egress-taint.js")>();
	return { ...actual, scanPageEgress: vi.fn() };
});

import { evaluateEgressForUrl } from "../security/layer/index.js";
import { scanPageEgress } from "./page-egress-taint.js";
import { answerEgressAsk, clearEgressDeny, enrichBlockedNavigation, peekEgressDeny, recentEgressDeny } from "./bridge-egress.js";

describe("browser egress deny reason correlation", () => {
	let sent: unknown[];

	beforeEach(() => {
		sent = [];
		process.send = ((msg: unknown) => { sent.push(msg); return true; }) as typeof process.send;
		vi.mocked(evaluateEgressForUrl).mockReset().mockReturnValue({ allowed: false, reason: "policy deny" });
		vi.mocked(scanPageEgress).mockReset().mockReturnValue({ allowed: true });
	});

	afterEach(() => {
		delete (process as { send?: unknown }).send;
		vi.useRealTimers();
	});

	it("denies and records the reason only for the attributed view", () => {
		answerEgressAsk({ id: 1, url: "http://localhost:3000/", viewId: "view-a-work" });
		expect(sent).toEqual([{ type: "lax:browser-egress-ask-result", id: 1, allowed: false }]);
		expect(recentEgressDeny("http://localhost:3000/", "view-b-work")).toBeNull();
		expect(recentEgressDeny("http://localhost:3000/")).toBeNull();
		expect(recentEgressDeny("http://localhost:3000/", "view-a-work")?.reason).toBe("policy deny");
	});

	it("keeps distinct policy reasons for the same URL in concurrent views", () => {
		vi.mocked(evaluateEgressForUrl)
			.mockReturnValueOnce({ allowed: false, reason: "reason A" })
			.mockReturnValueOnce({ allowed: false, reason: "reason B" });
		answerEgressAsk({ id: 2, url: "https://same.example/path", viewId: "view-a-work" });
		answerEgressAsk({ id: 3, url: "https://same.example/path", viewId: "view-b-work" });
		expect(recentEgressDeny("https://same.example/path", "view-a-work")?.reason).toBe("reason A");
		expect(recentEgressDeny("https://same.example/path", "view-b-work")?.reason).toBe("reason B");
	});

	it("keeps page-taint reasons scoped to their originating session views", () => {
		vi.mocked(evaluateEgressForUrl).mockReturnValue({ allowed: true, reason: "allowed" });
		vi.mocked(scanPageEgress).mockImplementation((sessionId) => ({
			allowed: false, layer: "data-lineage", canary: false, reason: `taint ${sessionId}`,
		}));
		answerEgressAsk({ id: 4, url: "https://sink.example/", viewId: "view-alpha-work" });
		answerEgressAsk({ id: 5, url: "https://sink.example/", viewId: "view-beta-work" });
		expect(recentEgressDeny("https://sink.example/", "view-alpha-work")?.reason).toBe("taint alpha");
		expect(recentEgressDeny("https://sink.example/", "view-beta-work")?.reason).toBe("taint beta");
	});

	it("consumes a matching deny once while normalizing query and trailing slash", () => {
		answerEgressAsk({ id: 6, url: "http://localhost:3000/?lax_token=abc", viewId: "view-a-work" });
		const raw = new Error("browser navigate failed: ERR_BLOCKED_BY_CLIENT");
		const enriched = enrichBlockedNavigation(raw, "http://localhost:3000", "view-a-work") as Error;
		expect(enriched.message).toContain("policy deny");
		expect(enrichBlockedNavigation(raw, "http://localhost:3000", "view-a-work")).toBe(raw);
	});

	it("clears a stale matching deny when a subsequent request is allowed", () => {
		answerEgressAsk({ id: 7, url: "https://retry.example/", viewId: "view-a-work" });
		vi.mocked(evaluateEgressForUrl).mockReturnValue({ allowed: true, reason: "allowed" });
		answerEgressAsk({ id: 8, url: "https://retry.example/", viewId: "view-a-work" });
		const raw = new Error("ERR_BLOCKED_BY_CLIENT");
		expect(enrichBlockedNavigation(raw, "https://retry.example/", "view-a-work")).toBe(raw);
	});

	it("expires a matching deny under the existing TTL", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		answerEgressAsk({ id: 9, url: "https://old.example/", viewId: "view-a-work" });
		vi.setSystemTime(31_001);
		expect(recentEgressDeny("https://old.example/", "view-a-work")).toBeNull();
	});

	it("peekEgressDeny reads without consuming; recentEgressDeny still gets its one consume", () => {
		answerEgressAsk({ id: 11, url: "https://peek.example/p", viewId: "view-a-work" });
		expect(peekEgressDeny("https://peek.example/p", "view-a-work")?.reason).toBe("policy deny");
		expect(peekEgressDeny("https://peek.example/p", "view-a-work")?.reason).toBe("policy deny"); // still there
		expect(peekEgressDeny("https://peek.example/p", "view-b-work")).toBeNull(); // view-scoped
		expect(recentEgressDeny("https://peek.example/p", "view-a-work")?.reason).toBe("policy deny");
		expect(peekEgressDeny("https://peek.example/p", "view-a-work")).toBeNull(); // consumed above
	});

	it("peekEgressDeny respects the TTL", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		answerEgressAsk({ id: 12, url: "https://peek-old.example/", viewId: "view-a-work" });
		vi.setSystemTime(31_001);
		expect(peekEgressDeny("https://peek-old.example/", "view-a-work")).toBeNull();
	});

	it("clearEgressDeny drops the recorded deny for exactly that view + URL", () => {
		answerEgressAsk({ id: 13, url: "https://clear.example/", viewId: "view-a-work" });
		answerEgressAsk({ id: 14, url: "https://clear.example/", viewId: "view-b-work" });
		clearEgressDeny("https://clear.example/", "view-a-work");
		expect(peekEgressDeny("https://clear.example/", "view-a-work")).toBeNull();
		expect(peekEgressDeny("https://clear.example/", "view-b-work")?.reason).toBe("policy deny");
	});

	it("passes non-policy and unmatched blocked failures through untouched", () => {
		answerEgressAsk({ id: 10, url: "https://kept.example/", viewId: "view-a-work" });
		const dns = new Error("ERR_NAME_NOT_RESOLVED");
		expect(enrichBlockedNavigation(dns, "https://kept.example/", "view-a-work")).toBe(dns);
		const blocked = new Error("ERR_BLOCKED_BY_CLIENT");
		expect(enrichBlockedNavigation(blocked, "https://other.example/", "view-a-work")).toBe(blocked);
		expect((enrichBlockedNavigation(blocked, "https://kept.example/", "view-a-work") as Error).message).toContain("policy deny");
	});
});

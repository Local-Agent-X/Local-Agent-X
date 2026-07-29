// @vitest-environment happy-dom
//
// Client-side durable-approval rediscovery. A pending approval is durable
// server-side (canonical pendingApproval column) but the live
// approval_requested WS event is not — a client that reloads, reconnects, or
// attaches after a server restart never sees the card and the op sits blocked
// until the ask times out. chat-ws.js now pulls GET /api/approvals/pending on
// every (re)connect and hydrates the current session's cards through the same
// approval_requested reducer the live event uses.
//
// Drives the REAL source files (no copies): chat-stream-store.js,
// chat-tool-cards.js, chat-ws.js — same new Function harness as
// chat-ws-stop-preserves-socket.test.ts / chat-caret-desync.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface StoreApproval {
	id: string;
	toolName: string;
	status: string;
	opId: string | null;
	expiresAt: number | null;
	delivery?: string;
}
interface StoreEntry { approvals: StoreApproval[]; status: string }
interface Store {
	get(sessionId: string): StoreEntry | null;
	applyEvent(sessionId: string, event: Record<string, unknown>): void;
	findApproval(approvalId: string): { sessionId: string; approval: StoreApproval } | null;
	resolveApprovalLocal(approvalId: string, approved: boolean): void;
	resolveApprovalRecorded(approvalId: string, approved: boolean): void;
	isStreaming(sessionId: string): boolean;
	inflightOps(): unknown[];
}

interface FakeWs {
	readyState: number;
	sent: string[];
	onopen: (() => void) | null;
	onmessage: ((e: { data: string }) => void) | null;
	send: (s: string) => void;
	close: () => void;
}

interface PendingEntry {
	opId: string;
	sessionId: string | null;
	approvalId: string;
	toolName: string;
	argsPreview: string;
	context: string | null;
	requestedAt: number;
	expiresAt: number;
}

const SESSION = "sess-1";

let store: Store;
let fakeSockets: FakeWs[];
let pendingResponse: PendingEntry[];
let dispatched: string[]; // frames delegated to handleChatWsMessage
let connectChatWs: () => void;
let rediscoverPendingApprovals: () => Promise<void>;
let handleDurableApprovalReply: (e: { data: string }) => boolean;
let scheduleApprovalExpiry: (sessionId: string, approvalId: string, expiresAt: number) => void;
let makeApprovalCard: (approvalId: string, toolName: string, context: string, argsPreview: string) => HTMLElement;
let applyApprovalRecordedState: (card: HTMLElement, approved: boolean) => void;
let sendApprovalResponse: (approvalId: string, approved: boolean, remember: boolean, opId?: string | null) => void;

function pendingEntry(over: Partial<PendingEntry> = {}): PendingEntry {
	const now = Date.now();
	return {
		opId: "op-1",
		sessionId: SESSION,
		approvalId: "ap-1",
		toolName: "bash",
		argsPreview: '{"command":"rm -rf x"}',
		context: "high-risk shell",
		requestedAt: now,
		expiresAt: now + 60_000,
		...over,
	};
}

// A LIVE ask as the server emits it (src/approval-manager.ts): no durable opId
// lookup involved, and — since the expiry work — carrying the same absolute
// auto-deny deadline the server's own timer is armed on.
function liveAsk(approvalId: string, expiresAt: number) {
	return {
		type: "approval_requested",
		approvalId,
		toolName: "bash",
		context: "high-risk shell",
		argsPreview: "{}",
		opId: "op-live",
		expiresAt,
	};
}

// chat-ws.js is loaded ONCE per file: it runs Object.defineProperty(window,
// 'chatWs', ...) at module level, which a second load can't redefine. Its
// bare-global references (ChatStreamStore, activeChat, apiFetch, ...) resolve
// at CALL time, so per-test isolation comes from re-pinning those globals —
// only the store IIFE (whose internal Map has no reset hook) reloads fresh.
let modulesLoaded = false;
function loadOnce() {
	if (modulesLoaded) return;
	modulesLoaded = true;
	const g = globalThis as unknown as Record<string, unknown>;

	class FakeWebSocket implements FakeWs {
		static OPEN = 1;
		readyState = 1;
		sent: string[] = [];
		onopen: (() => void) | null = null;
		onmessage: ((e: { data: string }) => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor() { fakeSockets.push(this); }
		send(s: string) { this.sent.push(s); }
		close() { /* noop */ }
	}
	g.WebSocket = FakeWebSocket;

	g.AUTH_TOKEN = "test-token";
	g.API = "";
	g.stopSpeaking = () => {};
	g.esc = (s: string) => s;
	g.handleChatWsMessage = (e: { data: string }) => { dispatched.push(e.data); };
	g.apiFetch = (path: string) => {
		if (path === "/api/approvals/pending") {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(pendingResponse) });
		}
		return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
	};

	// Real tool-cards module (plain top-level function declarations — export
	// via factory return, same pattern as the chat-ws.js load below).
	const cardsSrc = readFileSync(join(here, "../public/js/chat-tool-cards.js"), "utf8");
	// eslint-disable-next-line no-new-func
	const cardsFactory = new Function(cardsSrc + "\nreturn { makeApprovalCard, applyApprovalRecordedState };");
	({ makeApprovalCard, applyApprovalRecordedState } = cardsFactory());
	g.applyApprovalRecordedState = applyApprovalRecordedState;

	const wsSrc = readFileSync(join(here, "../public/js/chat-ws.js"), "utf8");
	// eslint-disable-next-line no-new-func
	const wsFactory = new Function(wsSrc + "\nreturn { connectChatWs };");
	({ connectChatWs } = wsFactory());
	sendApprovalResponse = (g.window as unknown as { sendApprovalResponse: typeof sendApprovalResponse }).sendApprovalResponse;
}

// Rediscovery module (split out of chat-ws.js for the 400-LOC gate) — loads
// before chat-ws.js in app.html so the onopen hook / onmessage intercept can
// reference these as bare globals, and AFTER chat-stream-store.js because it
// binds ChatStreamStore.subscribeAll at LOAD time (that subscription is what
// arms client-side expiry for live asks). Hence per-test, not in loadOnce:
// each test builds a fresh store, and the watch has to be on THAT one. Its
// consumers resolve bare globals at call time, so re-pinning is enough.
function loadRediscovery() {
	const g = globalThis as unknown as Record<string, unknown>;
	const rdSrc = readFileSync(join(here, "../public/js/chat-approval-rediscovery.js"), "utf8");
	// eslint-disable-next-line no-new-func
	const rdFactory = new Function(
		rdSrc + "\nreturn { rediscoverPendingApprovals, handleDurableApprovalReply, scheduleApprovalExpiry };",
	);
	({ rediscoverPendingApprovals, handleDurableApprovalReply, scheduleApprovalExpiry } = rdFactory());
	g.rediscoverPendingApprovals = rediscoverPendingApprovals;
	g.handleDurableApprovalReply = handleDurableApprovalReply;
	g.scheduleApprovalExpiry = scheduleApprovalExpiry;
}

beforeEach(() => {
	fakeSockets = fakeSockets || [];
	pendingResponse = [];
	dispatched = [];
	loadOnce();
	const g = globalThis as unknown as Record<string, unknown>;
	g.activeChat = { id: SESSION, messages: [] };
	// Fresh store per test — load every split module in app.html order so the
	// harness exercises the same reducer, finalizer, and approval extensions as
	// production. The core IIFE's internal Map has no reset hook.
	for (const file of [
		"chat-stream-blocks.js",
		"chat-stream-reducer.js",
		"chat-stream-store.js",
		"chat-stream-finalize.js",
		"chat-stream-store-approvals.js",
	]) {
		// eslint-disable-next-line no-new-func
		new Function(readFileSync(join(here, "../public/js", file), "utf8"))();
	}
	store = (g.window as { ChatStreamStore: Store }).ChatStreamStore;
	// Sibling modules reference it as a bare global — pin it (window.X
	// assignment alone doesn't create one in this harness).
	g.ChatStreamStore = store;
	loadRediscovery();
	// The shared fake socket persists across tests (connectChatWs early-returns
	// on an OPEN socket) — drop frames the previous test sent.
	for (const ws of fakeSockets) ws.sent.length = 0;
	dispatched.length = 0;
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.useRealTimers();
});

describe("rediscoverPendingApprovals — connect-time hydration", () => {
	it("hydrates a current-session pending approval with durable flags and marks the turn live", async () => {
		pendingResponse = [pendingEntry()];
		await rediscoverPendingApprovals();

		const entry = store.get(SESSION);
		expect(entry).not.toBeNull();
		expect(entry!.approvals).toHaveLength(1);
		const ap = entry!.approvals[0];
		expect(ap).toMatchObject({ id: "ap-1", toolName: "bash", status: "pending", opId: "op-1" });
		expect(ap.expiresAt).toBe(pendingResponse[0].expiresAt);
		// The op IS in flight server-side (blocked on the ask) — the turn must
		// read live so renderMessages synthesizes the row the card hangs off.
		expect(store.isStreaming(SESSION)).toBe(true);
	});

	it("runs from the WS onopen hook (connect AND reconnect share connectChatWs)", async () => {
		pendingResponse = [pendingEntry()];
		connectChatWs();
		fakeSockets[0].onopen!();
		await vi.waitFor(() => {
			expect(store.get(SESSION)?.approvals ?? []).toHaveLength(1);
		});
	});

	it("filters entries belonging to OTHER sessions", async () => {
		pendingResponse = [pendingEntry({ sessionId: "someone-else", approvalId: "ap-x", opId: "op-x" })];
		await rediscoverPendingApprovals();
		expect(store.get(SESSION)?.approvals ?? []).toHaveLength(0);
		expect(store.get("someone-else")).toBeNull();
	});

	it("filters entries already expired client-side", async () => {
		pendingResponse = [pendingEntry({ expiresAt: Date.now() - 1 })];
		await rediscoverPendingApprovals();
		expect(store.get(SESSION)?.approvals ?? []).toHaveLength(0);
	});

	it("dedupes against approvals already in the store (live event beat the fetch)", async () => {
		store.applyEvent(SESSION, {
			type: "approval_requested", approvalId: "ap-1", toolName: "bash",
			context: "high-risk shell", argsPreview: "{}",
		});
		pendingResponse = [pendingEntry()];
		await rediscoverPendingApprovals();
		await rediscoverPendingApprovals(); // reconnect: idempotent again
		expect(store.get(SESSION)!.approvals).toHaveLength(1);
	});

	it("store reducer itself dedupes a replayed approval_requested by approvalId", () => {
		const ev = { type: "approval_requested", approvalId: "ap-9", toolName: "write", argsPreview: "{}", context: null };
		store.applyEvent(SESSION, ev);
		store.applyEvent(SESSION, ev);
		expect(store.get(SESSION)!.approvals).toHaveLength(1);
	});

	it("expires a still-pending hydrated card when expiresAt passes", async () => {
		vi.useFakeTimers();
		pendingResponse = [pendingEntry({ expiresAt: Date.now() + 5_000 })];
		await rediscoverPendingApprovals();
		expect(store.get(SESSION)!.approvals[0].status).toBe("pending");
		vi.advanceTimersByTime(5_000 + 300); // scheduleApprovalExpiry pads 250ms
		expect(store.get(SESSION)!.approvals[0].status).toBe("timeout");
	});

	it("does NOT expire a card that was answered in the meantime", async () => {
		vi.useFakeTimers();
		pendingResponse = [pendingEntry({ expiresAt: Date.now() + 5_000 })];
		await rediscoverPendingApprovals();
		store.resolveApprovalRecorded("ap-1", true);
		vi.advanceTimersByTime(6_000);
		expect(store.get(SESSION)!.approvals[0].status).toBe("approved");
	});
});

// A live approval card's expiry used to depend entirely on the server
// broadcasting approval_timeout. This server froze its event loop for 90-110s
// at a stretch, 182 times — a broadcast that never fires leaves a dead card
// looking answerable forever. approval_requested carries expiresAt on the live
// event too, so the client arms the same fuse it already armed for hydrated
// cards, and the two settle paths are idempotent in either order.
describe("live approval asks — client-side expiry covers a missing broadcast", () => {
	it("flips a LIVE ask to timeout when its window passes with no server broadcast", () => {
		vi.useFakeTimers();
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		expect(store.get(SESSION)!.approvals[0].status).toBe("pending");

		// Expiry is the SERVER's decision — the client only covers for a
		// missing broadcast, so it must not fire ahead of the deadline.
		vi.advanceTimersByTime(5_000 - 1);
		expect(store.get(SESSION)!.approvals[0].status).toBe("pending");

		vi.advanceTimersByTime(1 + 300); // scheduleApprovalExpiry pads 250ms
		expect(store.get(SESSION)!.approvals[0].status).toBe("timeout");
	});

	it("disarms the fuse when the ask resolves first — no double-resolve, no dangling timer", () => {
		vi.useFakeTimers();
		const before = vi.getTimerCount();
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		expect(vi.getTimerCount()).toBe(before + 1);

		store.applyEvent(SESSION, { type: "approval_resolved", approvalId: "ap-live", approved: true });
		expect(vi.getTimerCount()).toBe(before);

		vi.advanceTimersByTime(60_000);
		expect(store.findApproval("ap-live")!.approval.status).toBe("approved");
	});

	// Hydration FIRST, then the live frame for the same ask (a reconnect that
	// beat the broadcast). The reducer dedupes the CARD, so this ordering is the
	// one where the armed-map guard is the only thing between one ask and two
	// fuses — the reverse order never reaches the arming site at all
	// (rediscoverPendingApprovals `continue`s at its own dedupe check).
	it("arms ONE fuse when the live event and rediscovery deliver the SAME ask", async () => {
		vi.useFakeTimers();
		const before = vi.getTimerCount();
		const expiresAt = Date.now() + 5_000;
		pendingResponse = [pendingEntry({ expiresAt })];
		await rediscoverPendingApprovals();
		expect(vi.getTimerCount()).toBe(before + 1);
		store.applyEvent(SESSION, liveAsk("ap-1", expiresAt));
		expect(vi.getTimerCount()).toBe(before + 1);
	});

	it("a late server approval_timeout does not overwrite a decision that already settled the card", () => {
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.applyEvent(SESSION, { type: "approval_resolved", approvalId: "ap-live", approved: true });
		store.applyEvent(SESSION, { type: "approval_timeout", approvalId: "ap-live" });
		expect(store.findApproval("ap-live")!.approval.status).toBe("approved");
	});

	it("a durably RECORDED decision is not overwritten by a late expiry either", () => {
		store.applyEvent(SESSION, liveAsk("ap-rec", Date.now() + 5_000));
		store.resolveApprovalRecorded("ap-rec", true); // server's durable-resolve reply
		store.applyEvent(SESSION, { type: "approval_timeout", approvalId: "ap-rec" });
		const ap = store.findApproval("ap-rec")!.approval;
		expect(ap.status).toBe("approved");
		expect(ap.delivery).toBe("recorded");
	});
});

// The click flips the card OPTIMISTICALLY — chat-ws.js sendApprovalResponse
// calls resolveApprovalLocal the instant the frame is handed to the socket,
// before the server has said whether the answer beat the deadline. In the last
// instant of the window (or on the far side of one of those 90-110s stalls) it
// did not: the server's own timer already auto-denied the ask, the tool NEVER
// RAN, and the late approval_response is rejected as unknown/expired by a reply
// no client code consumes. So the card's status says "approved" while the truth
// is "expired, auto-denied" — and an expiry is the only writer that will ever
// say so. `status` therefore cannot gate the timeout case; only WHO wrote the
// settle can.
describe("expiry vs an unconfirmed click — the optimistic flip is not a decision", () => {
	it("the server's approval_timeout corrects a card the Approve click only flipped locally", () => {
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.resolveApprovalLocal("ap-live", true);
		expect(store.findApproval("ap-live")!.approval.status).toBe("approved");
		store.applyEvent(SESSION, { type: "approval_timeout", approvalId: "ap-live" });
		expect(store.findApproval("ap-live")!.approval.status).toBe("timeout");
	});

	it("the same holds for a Deny click that missed the deadline", () => {
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.resolveApprovalLocal("ap-live", false);
		store.applyEvent(SESSION, { type: "approval_timeout", approvalId: "ap-live" });
		expect(store.findApproval("ap-live")!.approval.status).toBe("timeout");
	});

	// Same wrong card, minus the broadcast — which is the case this whole fuse
	// exists for. Disarming on the optimistic flip would leave "✓ Approved" on a
	// tool that never ran, and chat-stream-finalize.js then stamps that onto the
	// finalized row forever.
	it("keeps the fuse lit through an unconfirmed flip, so a swallowed broadcast still corrects it", () => {
		vi.useFakeTimers();
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.resolveApprovalLocal("ap-live", true);
		vi.advanceTimersByTime(5_000 + 300); // scheduleApprovalExpiry pads 250ms
		expect(store.findApproval("ap-live")!.approval.status).toBe("timeout");
	});

	// …and the moment the server DOES confirm, the fuse is out: a real decision
	// is never at the mercy of a deadline.
	it("the server's confirmation of that click disarms the fuse for good", () => {
		vi.useFakeTimers();
		const before = vi.getTimerCount();
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.resolveApprovalLocal("ap-live", true);
		expect(vi.getTimerCount()).toBe(before + 1); // still lit while unconfirmed
		store.applyEvent(SESSION, { type: "approval_resolved", approvalId: "ap-live", approved: true });
		expect(vi.getTimerCount()).toBe(before);
		vi.advanceTimersByTime(60_000);
		expect(store.findApproval("ap-live")!.approval.status).toBe("approved");
	});

	// CONTROL (passes at HEAD too, so it proves nothing on its own): the server's
	// decision outranks an expiry in BOTH orders. It is here so the new settle
	// stamp can never grow into a guard on approval_resolved as well.
	it("a real decision still lands on a card an expiry already settled", () => {
		store.applyEvent(SESSION, liveAsk("ap-live", Date.now() + 5_000));
		store.applyEvent(SESSION, { type: "approval_timeout", approvalId: "ap-live" });
		expect(store.findApproval("ap-live")!.approval.status).toBe("timeout");
		store.applyEvent(SESSION, { type: "approval_resolved", approvalId: "ap-live", approved: true });
		expect(store.findApproval("ap-live")!.approval.status).toBe("approved");
	});
});

describe("approval_response — opId inclusion", () => {
	it("includes opId in the WS frame when the card carries one (durable-sourced)", async () => {
		pendingResponse = [pendingEntry()];
		await rediscoverPendingApprovals();
		connectChatWs();
		const ws = fakeSockets[0];
		ws.sent.length = 0;

		// Click path: makeApprovalCard looks the opId up from the store.
		const card = makeApprovalCard("ap-1", "bash", "high-risk shell", "{}");
		document.body.appendChild(card);
		(card.querySelector(".btn-approve") as HTMLButtonElement).click();

		const frames = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "approval_response");
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ approvalId: "ap-1", approved: true, opId: "op-1" });
	});

	it("omits opId for live cards that never carried one", () => {
		connectChatWs();
		const ws = fakeSockets[0];
		ws.sent.length = 0;
		sendApprovalResponse("ap-live", false, false);
		const frame = JSON.parse(ws.sent[0]);
		expect(frame.type).toBe("approval_response");
		expect("opId" in frame).toBe(false);
	});
});

describe("recorded-resolution reply — approval_resolved with delivery:'recorded'", () => {
	it("consumes the bare reply, flags the store approval, and flips the on-screen card", async () => {
		pendingResponse = [pendingEntry()];
		await rediscoverPendingApprovals();
		const card = makeApprovalCard("ap-1", "bash", "high-risk shell", "{}");
		document.body.appendChild(card);

		const consumed = handleDurableApprovalReply({
			data: JSON.stringify({ type: "approval_resolved", approvalId: "ap-1", toolName: "bash", approved: true, delivery: "recorded" }),
		});
		expect(consumed).toBe(true);

		const ap = store.findApproval("ap-1")!.approval;
		expect(ap.status).toBe("approved");
		expect(ap.delivery).toBe("recorded");

		expect(card.classList.contains("approved")).toBe(true);
		expect(card.classList.contains("recorded")).toBe(true);
		expect(card.querySelector(".approval-recorded-note")!.textContent).toBe("Recorded — applies when the agent resumes");
		card.querySelectorAll("button").forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
	});

	it("a REBUILT card re-applies the recorded state from the store flag", async () => {
		pendingResponse = [pendingEntry()];
		await rediscoverPendingApprovals();
		store.resolveApprovalRecorded("ap-1", false);

		// Re-render path: chat-render-artifacts.js calls makeApprovalCard fresh.
		const rebuilt = makeApprovalCard("ap-1", "bash", "high-risk shell", "{}");
		expect(rebuilt.classList.contains("denied")).toBe(true);
		expect(rebuilt.classList.contains("recorded")).toBe(true);
		expect(rebuilt.querySelector(".approval-recorded-note")).not.toBeNull();
	});

	it("does not intercept normal envelope-wrapped or non-recorded frames", () => {
		expect(handleDurableApprovalReply({
			data: JSON.stringify({ type: "event", sessionId: SESSION, event: { type: "approval_resolved", approvalId: "ap-1", approved: true } }),
		})).toBe(false);
		expect(handleDurableApprovalReply({
			data: JSON.stringify({ type: "approval_resolved", approvalId: "ap-1", approved: true }),
		})).toBe(false);
		// Delegation still happens for everything else via the onmessage wrapper.
		connectChatWs();
		fakeSockets[0].onmessage!({ data: JSON.stringify({ type: "pong" }) });
		expect(dispatched).toHaveLength(1);
	});

	it("store applyEvent carries delivery:'recorded' through the envelope-wrapped reducer too", () => {
		store.applyEvent(SESSION, { type: "approval_requested", approvalId: "ap-2", toolName: "write", argsPreview: "{}" });
		store.applyEvent(SESSION, { type: "approval_resolved", approvalId: "ap-2", approved: true, delivery: "recorded" });
		const ap = store.findApproval("ap-2")!.approval;
		expect(ap.status).toBe("approved");
		expect(ap.delivery).toBe("recorded");
	});
});

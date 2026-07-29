// @vitest-environment happy-dom
//
// Regression: a settled approval card kept its FULL action box. The terminal
// branch only added a class, rewrote the status line and set button.disabled —
// both <button>s stayed in the DOM and CSS merely dropped them to opacity .5,
// which still reads as clickable. A bash approval that expired unseen (the
// server's 5-minute budget auto-DENIES, so the command never ran) therefore sat
// in the conversation forever behind a green-looking Approve button, and
// promoteLiveToMessages copied it onto the finalized row, so it came back on
// every reload. Nothing announced a LIVE ask either — the card appends to the
// BOTTOM of the assistant bubble, below the activity box, inside a bubble that
// reserves a viewport of pin-bottom room, so it can paint entirely off-screen —
// and no countdown was ever shown, so nothing warned that silence AUTO-DENIES
// the call inside the server's 5-minute budget.
//
// The countdown itself then went wrong in the opposite direction: it was dated
// from the card's FIRST RENDER, and first render is not arrival. An ask for a
// session the user is not viewing is never painted (chat-ws-handler-chat-events.js
// only repaints the VIEWED session) and rerenderLiveMessage paints inside
// requestAnimationFrame, which the browser/Electron PAUSES while the window is
// hidden, minimized or occluded (documented at chat-render-live.js). Four
// minutes of a five-minute budget could burn before the first frame, and the
// card then read "4:00 left" at the instant the server auto-DENIED the request.
// The deadline is now carried on the live `approval_requested` event itself
// (src/approval-manager.ts → src/types/server-events.ts) as an ABSOLUTE epoch
// ms, so a paused frame, a hidden window and a non-viewed session cannot drift
// it. It stays OPTIONAL: an ask that arrives without one gets no clock at all,
// because no clock is honest and a wrong clock is not.
//
// Drives the REAL client sources through happy-dom (no copies): the store split
// for the persisted-row case, chat-tool-cards.js for the canonical card DOM,
// chat-render-approvals.js for the live/terminal shape decision, and
// chat-render-artifacts.js for the caller. Same `new Function` harness as
// chat-stream-store-dedup.test.ts / approval-rediscovery.test.ts. The
// server↔client seam is driven end to end against the REAL ApprovalManager.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { APPROVAL_TIMEOUT_MS, getApprovalManager } from "../src/approval-manager.js";
import type { ServerEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Approval {
	id: string;
	toolName: string;
	context?: string | null;
	argsPreview?: string;
	status: string;
	expiresAt?: number | null;
	resolvedAt?: number | null;
	delivery?: string;
	historical?: boolean;
}
interface FinalizedMsg { _approvals?: Approval[] }
interface Store {
	startTurn(sessionId: string, anchorIdx?: number): unknown;
	applyEvent(sessionId: string, event: Record<string, unknown>): void;
	get(sessionId: string): { approvals: Approval[] } | null;
	promoteLiveToMessages(sessionId: string, chat: { messages: unknown[] }): FinalizedMsg | null;
}
type RenderArtifacts = (bodyEl: HTMLElement, data: Record<string, unknown>) => void;

const SESSION = "sess-approval";

let renderArtifacts: RenderArtifacts;
let store: Store;

// Every module reloads per test: the render modules keep the per-ask arrival
// ledger at module scope and the store core closes over a Map with no reset
// hook, so a fresh execution is the only isolation. None of them run a
// window.defineProperty at load, so repeated loads are safe (unlike chat-ws.js).
function loadClientModules() {
	const g = globalThis as unknown as Record<string, unknown>;
	const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
	g.esc = (s: string) => s;

	const cards = new Function(src("chat-tool-cards.js") + "\nreturn { makeApprovalCard };")() as Record<string, unknown>;
	g.makeApprovalCard = cards.makeApprovalCard;

	const approvals = new Function(src("chat-render-approvals.js") + "\nreturn { renderApproval };")() as Record<string, unknown>;
	g.renderApproval = approvals.renderApproval;

	const artifacts = new Function(
		src("chat-render-artifacts.js") + "\nreturn { _renderAssistantToolArtifacts };",
	)() as { _renderAssistantToolArtifacts: RenderArtifacts };
	renderArtifacts = artifacts._renderAssistantToolArtifacts;

	for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
		new Function(src(f))();
	}
	store = (g.window as { ChatStreamStore: Store }).ChatStreamStore;
	g.ChatStreamStore = store;
}

// Render an assistant body with ONLY approvals on it — the tool-card / chip /
// progress branches are untouched by this change and their deps aren't stubbed.
function renderApprovals(list: Approval[]): HTMLElement {
	const body = document.createElement("div");
	document.body.appendChild(body);
	renderArtifacts(body, { toolEvents: [], chips: [], progressByTool: {}, approvals: list, stopNote: null });
	return body;
}

function settled(over: Partial<Approval> = {}): Approval {
	return {
		id: "ap-1",
		toolName: "bash",
		context: "high-risk shell",
		argsPreview: '{"command":"rm -rf /tmp/x"}',
		status: "timeout",
		expiresAt: null,
		resolvedAt: Date.UTC(2026, 6, 28, 17, 4, 0),
		...over,
	};
}

beforeEach(() => {
	document.body.innerHTML = "";
	loadClientModules();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("terminal approvals — compact audit record, zero affordances", () => {
	it("collapses a timed-out ask to a one-line record with NO buttons in the DOM", () => {
		const body = renderApprovals([settled()]);

		expect(body.querySelectorAll("button")).toHaveLength(0);
		expect(body.querySelector(".approval-actions")).toBeNull();
		expect(body.querySelector(".approval-card")).toBeNull();

		const rec = body.querySelector(".approval-record");
		expect(rec).not.toBeNull();
		expect(rec!.classList.contains("timeout")).toBe(true);
		// The audit record survives: what was asked, what happened, when.
		expect(rec!.textContent).toContain("bash");
		expect(rec!.textContent!.toLowerCase()).toContain("auto-denied");
		expect(rec!.textContent!.toLowerCase()).toContain("nothing ran");
		expect(rec!.getAttribute("title")).toContain("rm -rf /tmp/x");
	});

	it("records an approved ask without leaving anything clickable behind", () => {
		const body = renderApprovals([settled({ status: "approved" })]);
		expect(body.querySelectorAll("button")).toHaveLength(0);
		const rec = body.querySelector(".approval-record")!;
		expect(rec.classList.contains("approved")).toBe(true);
		expect(rec.textContent).toContain("Approved");
	});

	it("says a denied ask means nothing ran", () => {
		const body = renderApprovals([settled({ status: "denied" })]);
		expect(body.querySelectorAll("button")).toHaveLength(0);
		expect(body.querySelector(".approval-record")!.textContent!.toLowerCase()).toContain("nothing ran");
	});

	it("keeps the superseded copy that tells the user to ask again", () => {
		const body = renderApprovals([settled({ status: "superseded" })]);
		const rec = body.querySelector(".approval-record")!;
		expect(rec.classList.contains("superseded")).toBe(true);
		expect(rec.textContent).toContain("Ask again");
	});
});

describe("live approvals — announced, and on a visible fuse", () => {
	const live = (over: Partial<Approval> = {}): Approval => ({
		id: "ap-live",
		toolName: "bash",
		context: "high-risk shell",
		argsPreview: "{}",
		status: "pending",
		expiresAt: Date.now() + 125_000,
		resolvedAt: null,
		...over,
	});

	it("renders a countdown derived from expiresAt that names the DENIAL consequence", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + 125_000 })]);

		const clock = body.querySelector(".approval-countdown");
		expect(clock).not.toBeNull();
		expect(clock!.textContent).toContain("2:05");
		expect(clock!.textContent!.toLowerCase()).toContain("auto-denies");
		// Still genuinely answerable — the buttons are present and enabled.
		expect(body.querySelectorAll(".approval-actions button:not([disabled])")).toHaveLength(2);
	});

	it("shows no clock at all for an ask that carries no deadline", () => {
		// expiresAt is OPTIONAL end to end. An emitter that does not set one still
		// gets a fully answerable card — it just gets no digits, because a clock
		// this client dated itself is exactly the lie this seam exists to stop.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: null })]);

		expect(body.querySelector(".approval-countdown")).toBeNull();
		expect(body.textContent).not.toContain("NaN");
		// Everything else about the live card is unchanged.
		expect(body.querySelector(".approval-card.live")).not.toBeNull();
		expect(body.querySelectorAll(".approval-actions button:not([disabled])")).toHaveLength(2);
		// And no 1Hz ticker is left running for a card that has nothing to count.
		vi.advanceTimersByTime(3_000);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("runs on an inherited window when a re-ask carries an EARLIER deadline", () => {
		// approval-manager reconcileRecoveredAsk deliberately does not restart the
		// 5 minutes for a crash-recovered ask — the re-ask times out when the
		// ORIGINAL window ends. The absolute deadline carries that faithfully;
		// anything computed from "now" would hand the user back a fresh budget.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + 40_000 })]);
		const clock = body.querySelector(".approval-countdown")!;
		expect(clock.textContent).toContain("0:40");
		expect(Number(clock.getAttribute("data-expires-at"))).toBe(Date.now() + 40_000);
	});

	it("ticks the countdown down as the fuse burns", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + 125_000 })]);
		vi.advanceTimersByTime(65_000);
		const clock = body.querySelector(".approval-countdown")!;
		expect(clock.textContent).toContain("1:00");
		expect(clock.classList.contains("urgent")).toBe(true);
	});

	it("burns the fuse from its own timer, not from a bubble repaint", () => {
		// A store-driven repaint would re-parse the entire turn's markdown; paying
		// that once a second to move one digit is worse than the missing clock. The
		// SAME node must be mutated in place between renders.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + APPROVAL_TIMEOUT_MS })]);
		const clock = body.querySelector(".approval-countdown")!;
		expect(clock.textContent).toContain("5:00");

		vi.advanceTimersByTime(61_000);
		expect(body.querySelector(".approval-countdown")).toBe(clock);
		expect(clock.textContent).toContain("3:59");
		expect(clock.classList.contains("urgent")).toBe(false);
	});

	it("re-attaches the countdown across a live-bubble rebuild, without restarting it", () => {
		// chat-render-live.js destroys and rebuilds the bubble on every WS event.
		// The rebuilt card must inherit the ORIGINAL deadline (not restart at 5:00)
		// and the shared ticker must find the fresh node.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const ap = live({ expiresAt: Date.now() + APPROVAL_TIMEOUT_MS });
		const first = renderApprovals([ap]);
		vi.advanceTimersByTime(30_000);
		first.remove();

		const rebuilt = renderApprovals([ap]);
		const clock = rebuilt.querySelector(".approval-countdown")!;
		expect(clock.textContent).toContain("4:30");
		vi.advanceTimersByTime(2_000);
		expect(clock.textContent).toContain("4:28");
	});

	it("drops the fuse once the user answers, instead of counting down under an answered card", () => {
		// The click handler marks the card immediately; the store round-trip that
		// replaces it with a record lands later. In between, a fuse still counting
		// toward auto-denial contradicts the "Approved" status line.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + APPROVAL_TIMEOUT_MS })]);
		expect(body.querySelector(".approval-countdown")).not.toBeNull();

		(body.querySelector(".btn-approve") as HTMLButtonElement).click();
		vi.advanceTimersByTime(1_000);
		expect(body.querySelector(".approval-countdown")).toBeNull();
	});

	it("says the ask expired when the fuse burns out, and stops ticking", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const body = renderApprovals([live({ expiresAt: Date.now() + APPROVAL_TIMEOUT_MS })]);
		vi.advanceTimersByTime(301_000);
		const clock = body.querySelector(".approval-countdown")!;
		expect(clock.textContent!.toLowerCase()).toContain("auto-denied");
		expect(clock.textContent!.toLowerCase()).toContain("nothing ran");
		expect(clock.classList.contains("urgent")).toBe(true);
		// The 1Hz timer must not outlive the ask it was counting.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("marks the live card unmissable and brings it into view exactly once", () => {
		vi.useFakeTimers();
		const scrolled: unknown[] = [];
		(globalThis as unknown as { Element: { prototype: Record<string, unknown> } })
			.Element.prototype.scrollIntoView = function scrollIntoView(this: unknown) { scrolled.push(this); };

		const ap = live();
		const body = renderApprovals([ap]);
		expect(body.querySelector(".approval-card.live")).not.toBeNull();
		vi.advanceTimersByTime(200);
		expect(scrolled).toHaveLength(1);

		// The live bubble is rebuilt on every throttled swap — a re-render of the
		// SAME ask must not yank the viewport again.
		renderApprovals([ap]);
		vi.advanceTimersByTime(200);
		expect(scrolled).toHaveLength(1);
	});
});

// The seam this chunk exists for, driven end to end with no stand-ins: the REAL
// ApprovalManager emits, the REAL store reducer files the event, the REAL
// renderer paints it. Nothing here re-derives a deadline — if the manager stops
// sending one, or the reducer stops carrying it, or the renderer stops reading
// it, these fail.
describe("the auto-deny deadline comes from the server, not from first paint", () => {
	// One live ask on the real manager. The emit happens synchronously inside
	// requestApproval for a non-op card (no durable bridge await), so the event
	// is on the wire by the time this returns. The returned promise is settled by
	// the caller through clearSession, which also disarms the 5-minute timer.
	function askThroughTheServer(sessionId: string, command: string) {
		const events: ServerEvent[] = [];
		const mgr = getApprovalManager();
		const settled = mgr.requestApproval({
			toolName: "bash",
			toolCallId: "tc-deadline",
			sessionId,
			context: "high-risk shell",
			args: { command },
			emit: (e: ServerEvent) => { events.push(e); },
		});
		const asked = events.find((e) => e.type === "approval_requested");
		expect(asked, "the manager emitted no approval_requested").toBeDefined();
		return { asked: asked as Extract<ServerEvent, { type: "approval_requested" }>, settled, mgr };
	}

	it("puts the absolute auto-deny instant on the LIVE approval_requested event", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const sid = "sess-live-deadline";
		const { asked, settled, mgr } = askThroughTheServer(sid, "rm -rf /tmp/deadline-a");

		// Exactly the instant the manager's own timer is armed for — same
		// requestedAt + APPROVAL_TIMEOUT_MS, so the clock and the auto-denial
		// cannot disagree by even a frame.
		expect(asked.expiresAt).toBe(Date.now() + APPROVAL_TIMEOUT_MS);

		mgr.clearSession(sid);
		await expect(settled).resolves.toBe(false);
	});

	it("shows the TRUE time left when the card is first painted minutes after the ask", async () => {
		// THE regression. The ask arrives for a session the user is not viewing
		// (chat-ws-handler-chat-events.js skips the repaint) or into a hidden
		// window whose requestAnimationFrame is paused (chat-render-live.js), so
		// four of the five minutes burn before the first frame. Dating the fuse
		// from that frame printed "5:00" one minute before the server auto-denied.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-28T17:00:00Z"));
		const sid = "sess-late-paint";
		const askedAt = Date.now();
		const { asked, settled, mgr } = askThroughTheServer(sid, "rm -rf /tmp/deadline-b");

		// The event lands in the store. Nothing paints.
		store.startTurn(SESSION, 0);
		store.applyEvent(SESSION, asked as unknown as Record<string, unknown>);
		expect(store.get(SESSION)!.approvals[0].expiresAt).toBe(askedAt + APPROVAL_TIMEOUT_MS);

		vi.advanceTimersByTime(240_000);

		// First frame, four minutes late.
		const body = renderApprovals(store.get(SESSION)!.approvals);
		const clock = body.querySelector(".approval-countdown")!;
		expect(clock.textContent).toContain("1:00");
		expect(clock.textContent).not.toContain("5:00");
		expect(Number(clock.getAttribute("data-expires-at"))).toBe(askedAt + APPROVAL_TIMEOUT_MS);

		// One more minute and the fuse is out — at the same instant the server's
		// timer would have fired, not five minutes after it.
		vi.advanceTimersByTime(60_000);
		expect(clock.textContent!.toLowerCase()).toContain("auto-denied");

		mgr.clearSession(sid);
		await expect(settled).resolves.toBe(false);
	});
});

describe("persisted rows — a finalized turn can never be actionable again", () => {
	it("stamps promoted approvals historical and renders them as a record, not a box", () => {
		const chat = { messages: [] as unknown[] };
		store.startTurn(SESSION, 0);
		store.applyEvent(SESSION, { type: "stream", delta: "Running that now." });
		store.applyEvent(SESSION, {
			type: "approval_requested", approvalId: "ap-persisted", toolName: "bash",
			context: "high-risk shell", argsPreview: '{"command":"npm run deploy"}',
			expiresAt: Date.now() + 300_000,
		});
		store.applyEvent(SESSION, { type: "done" });

		const msg = store.promoteLiveToMessages(SESSION, chat)!;
		expect(msg._approvals).toHaveLength(1);
		// The ask never settled before the turn ended — status is still 'pending',
		// which is exactly what used to re-paint a live-looking box on reload.
		expect(msg._approvals![0].status).toBe("pending");
		expect(msg._approvals![0].historical).toBe(true);

		const body = renderApprovals(msg._approvals!);
		expect(body.querySelectorAll("button")).toHaveLength(0);
		expect(body.querySelector(".approval-card")).toBeNull();
		expect(body.querySelector(".approval-countdown")).toBeNull();
		const rec = body.querySelector(".approval-record")!;
		expect(rec.textContent).toContain("bash");
		expect(rec.textContent!.toLowerCase()).toContain("nothing ran");
	});
});

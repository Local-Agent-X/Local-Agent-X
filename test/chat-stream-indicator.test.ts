// @vitest-environment happy-dom
//
// Regression: the only moving elements in a live turn were provably
// disconnected from the stream.
//
//   - the toolbar STREAMING chip (#stream-indicator) painted one boolean —
//     "a turn exists" — so it read identically whether tokens were pouring in
//     or the server's event loop had been dead for two minutes;
//   - the themed thinking phrase rotated on a blind 3.8s setInterval with no
//     input from the stream at all, so motion meant nothing and users learned
//     to ignore it.
//
// Fix: one derivation (streamActivitySignal in thinking-phrases.js) over real
// state — isContentIdle (chat-render-artifacts.js, the same predicate the live
// bubble uses) for "is anything arriving", store.lastActivityMs for proof of
// life, and the op_heartbeat payload for what the turn is doing. Both
// affordances read it: the chip labels the state and stills its dot when there
// is no signal, and the phrase rotation freezes on the silence line instead of
// implying progress.
//
// The two clocks are NOT interchangeable and the suite has to prove it:
// content age answers "is anything on screen", activity age answers "is the op
// alive". A five-minute `bash` build is content-stale and alive; a dead server
// is both. Deriving liveness from the content clock would call the build dead,
// so at least one case must age the two apart.
//
// This drives the REAL wiring — both source files loaded, no copies — and
// asserts on STATE only. Idleness is expressed by ageing the store's own
// timestamps, never by sleeping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface StoreEntry {
	lastContentMs: number;
	lastActivityMs: number;
	opId: string | null;
}
interface Store {
	startTurn(sessionId: string, anchorIdx?: number): unknown;
	adoptTurn(sessionId: string, anchorIdx: number): boolean;
	applyEvent(sessionId: string, event: { type: string } & Record<string, unknown>): void;
	isStreaming(sessionId: string): boolean;
	get(sessionId: string): StoreEntry;
}

const sessionId = "chat-signal";
// Mirrors SIGNAL_TICK_MS / the phrase rotation cadence in the source files.
const SIGNAL_TICK_MS = 3000;
const PHRASE_TICK_MS = 3800;

let ChatStreamStore: Store;

function read(...files: string[]): string {
	return files.map(f => readFileSync(join(here, "../public/js", f), "utf8")).join("\n;\n");
}
function doc(): Document {
	return (globalThis as unknown as { document: Document }).document;
}
function win(): { thinkingHTML(): string; updateStreamUI(): void } {
	return (globalThis as unknown as { window: { thinkingHTML(): string; updateStreamUI(): void } }).window;
}

// ── The toolbar chip ──
function chip(): HTMLElement {
	return doc().getElementById("stream-indicator") as HTMLElement;
}
function chipState(): string | undefined { return chip().dataset.signal; }
function chipLabel(): string { return chip().querySelector(".si-label")!.textContent || ""; }
function chipDotStill(): boolean {
	return (chip().querySelector(".chat-dot") as HTMLElement).style.animation === "none";
}

// ── The thinking indicator ──
// The live bubble exactly as chat-render-artifacts.js / chat-send.js build it:
// a .msg.assistant stamped data-live="1". That stamp is what marks the ONE
// indicator this signal is derived for — the finalize path deletes it, and
// addMessageEl (the voice/worker path) never sets it.
function renderLiveBubble(): HTMLElement {
	doc().getElementById("messages")!.innerHTML =
		'<div class="msg assistant" data-live="1"><div class="msg-body">' +
		win().thinkingHTML() + "</div></div>";
	return doc().querySelector('[data-live="1"] .thinking') as HTMLElement;
}
// A voice reply bubble: same markup, built through addMessageEl, which does
// NOT stamp data-live because it also builds persisted rows.
function renderVoiceBubble(): HTMLElement {
	const div = doc().createElement("div");
	div.className = "msg assistant";
	div.innerHTML = '<div class="msg-body">' + win().thinkingHTML() + "</div>";
	doc().getElementById("messages")!.appendChild(div);
	return div.querySelector(".thinking") as HTMLElement;
}
function thinking(): HTMLElement { return doc().querySelector(".thinking") as HTMLElement; }
function phraseOf(el: HTMLElement): string {
	return el.querySelector(".thinking-phrase")!.textContent || "";
}
function stillOf(el: HTMLElement): boolean {
	return (el.querySelector("span:not(.thinking-phrase)") as HTMLElement).style.animation === "none";
}
function phrase(): string { return phraseOf(thinking()); }
function dotsStill(): boolean { return stillOf(thinking()); }

// Express idleness as STATE: push the store's own clocks into the past.
// `lastContentMs` alone = nothing visible arriving (but the op is alive);
// both = the turn went quiet entirely, which is the wedged/dead-server case.
function ageContent(ms: number): void {
	ChatStreamStore.get(sessionId).lastContentMs = Date.now() - ms;
}
function ageWholeTurn(ms: number): void {
	const e = ChatStreamStore.get(sessionId);
	e.lastContentMs = Date.now() - ms;
	e.lastActivityMs = Date.now() - ms;
}

beforeEach(() => {
	// Fake ONLY the interval timers — the signal is derived from real Date.now
	// arithmetic against the store's timestamps, so the clock must stay real.
	// Installed before the sources load so their setInterval registrations are
	// the fake ones and each test starts with a clean timer set.
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

	const g = globalThis as unknown as {
		window: { ChatStreamStore: Store; isStreaming: Store["isStreaming"]; activeChat: { id: string } };
		document: Document;
		ChatStreamStore: Store;
	};

	// Every real store module, in app.html order — fresh IIFEs, so the maps and
	// subscriber sets start empty.
	// eslint-disable-next-line no-new-func
	new Function(read(
		"chat-stream-blocks.js",
		"chat-stream-reducer.js",
		"chat-stream-store.js",
		"chat-stream-finalize.js",
		"chat-stream-store-approvals.js",
	))();
	ChatStreamStore = g.window.ChatStreamStore;

	// chat-uploads.js reaches ChatStreamStore as a bare global inside a
	// try/catch (a swallowed catch would make this pass for the wrong reason),
	// and mirrors chat.js's window.isStreaming + the active view.
	g.ChatStreamStore = ChatStreamStore;
	g.window.isStreaming = ChatStreamStore.isStreaming;
	g.window.activeChat = { id: sessionId };

	// The composer chip exactly as app.html ships it.
	g.document.body.innerHTML =
		'<div id="messages"></div>' +
		'<span id="stream-indicator" title="A turn is in flight. The send button will inject into the running turn."' +
		' style="display:none"><span class="chat-dot active-pulse"></span>' +
		'<span class="si-label">STREAMING</span></span>';

	// One scope for the three, in app.html order, on purpose: in the browser
	// they are classic scripts sharing one global lexical environment, which is
	// how thinking-phrases.js reaches isContentIdle / STREAM_IDLE_MS by bare
	// name. Separate Function scopes would break a coupling that is real in
	// production — and the order is load-bearing too, since the beat-parking
	// subscriber must register before the chip's repaint subscriber.
	// eslint-disable-next-line no-new-func
	new Function(read("chat-render-artifacts.js", "thinking-phrases.js", "chat-uploads.js"))();
});

afterEach(() => { vi.useRealTimers(); });

describe("stream indicator ↔ real stream signal", () => {
	it("reads STREAMING and keeps moving while content is actually arriving", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "on it" });

		expect(chipState()).toBe("flowing");
		expect(chipLabel()).toBe("STREAMING");
		expect(chipDotStill()).toBe(false);
	});

	it("names the in-flight tool when nothing is on screen but the op is alive", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "t1" });
		// Long silent tool call: nothing visible for half a minute…
		ageContent(30_000);
		// …but the server is beating, so the turn is provably working.
		ChatStreamStore.applyEvent(sessionId, { type: "op_heartbeat", opId: "op-1" });

		expect(chipState()).toBe("working");
		expect(chipLabel()).toBe("WORKING · BASH");
		expect(chipDotStill()).toBe(false);
	});

	it("takes the activity from the heartbeat payload once the local tool tail closed", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-1" });
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "grep", toolCallId: "t1" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_end", toolName: "grep", toolCallId: "t1", status: "ok" });
		ageContent(30_000);
		ChatStreamStore.applyEvent(sessionId,
			{ type: "op_heartbeat", opId: "op-1", phase: "tool", activeTool: "build_app" });

		expect(chipState()).toBe("working");
		expect(chipLabel()).toBe("WORKING · BUILD_APP");
	});

	it("ignores a heartbeat that belongs to some other op", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-2" });
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ageContent(30_000);
		// A beat from the previous turn must never label this one.
		ChatStreamStore.applyEvent(sessionId,
			{ type: "op_heartbeat", opId: "op-1", activeTool: "build_app" });

		expect(chipState()).toBe("working");
		expect(chipLabel()).toBe("WORKING");
	});

	it("stops claiming — and stops moving — when the turn goes silent", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "t1" });
		ageContent(30_000);
		ChatStreamStore.applyEvent(sessionId, { type: "op_heartbeat", opId: "op-1" });
		expect(chipState()).toBe("working");

		// The turn wedges: no output, no heartbeat, and — the whole point — no
		// further store mutation to repaint from. Only the signal's own clock
		// can demote it.
		ageWholeTurn(120_000);
		vi.advanceTimersByTime(SIGNAL_TICK_MS);

		expect(ChatStreamStore.isStreaming(sessionId)).toBe(true);
		expect(chipState()).toBe("silent");
		expect(chipLabel()).toBe("NO SIGNAL");
		expect(chipDotStill()).toBe(true);
	});

	it("stays WORKING through a long content silence while the server keeps beating", () => {
		// The five-minute `bash` build — the exact case op_heartbeat exists for.
		// Nothing visible has landed for MINUTES, so the content clock is far
		// past the 45s liveness window; the beat is seconds old. Liveness must be
		// read off the ACTIVITY clock. Deriving it from the content clock instead
		// passes every other test in this file and calls this turn dead.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-1" });
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "building" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_start", toolName: "bash", toolCallId: "t1" });
		ChatStreamStore.applyEvent(sessionId, { type: "tool_end", toolName: "bash", toolCallId: "t1", status: "ok" });
		ageWholeTurn(300_000);
		ChatStreamStore.applyEvent(sessionId,
			{ type: "op_heartbeat", opId: "op-1", phase: "tool", activeTool: "bash" });
		vi.advanceTimersByTime(SIGNAL_TICK_MS);

		// The two clocks really are aged apart — without this the case is vacuous.
		const e = ChatStreamStore.get(sessionId);
		expect(Date.now() - e.lastContentMs).toBeGreaterThan(250_000);
		expect(Date.now() - e.lastActivityMs).toBeLessThan(5_000);

		expect(chipState()).toBe("working");
		expect(chipLabel()).toBe("WORKING · BASH");
		expect(chipDotStill()).toBe(false);
	});

	it("pins the liveness window between one missed beat and three", () => {
		// The window is "two missed 20s beats", ahead of chat-ws.js's 60s stuck-
		// stream recovery. Anything in (30s, 60s) satisfies both ends; anything
		// outside breaks one of them, which is what these two assertions catch.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });

		ageWholeTurn(30_000);
		vi.advanceTimersByTime(SIGNAL_TICK_MS);
		expect(chipState()).toBe("working");

		ageWholeTurn(60_000);
		vi.advanceTimersByTime(SIGNAL_TICK_MS);
		expect(chipState()).toBe("silent");
	});

	it("reports NO SIGNAL on a turn adopted mid-flight that then went quiet", () => {
		// The reload-because-it-looked-stuck path. A tab that never ran startTurn
		// learns the turn from chat_op_started (and, on durable-approval
		// rediscovery, approval_requested) — both bump lastActivityMs and neither
		// bumps lastContentMs, so the entry has NO content clock at all. That is
		// the strongest form of "nothing is arriving", not a reason to keep
		// claiming STREAMING: the tab the user opened to diagnose a wedge is
		// exactly the tab that must be able to say NO SIGNAL.
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-1" });
		ChatStreamStore.applyEvent(sessionId,
			{ type: "approval_requested", approvalId: "a1", toolName: "bash" });
		ChatStreamStore.adoptTurn(sessionId, 0);
		expect(ChatStreamStore.get(sessionId).lastContentMs).toBe(0);

		ChatStreamStore.get(sessionId).lastActivityMs = Date.now() - 120_000;
		vi.advanceTimersByTime(SIGNAL_TICK_MS);

		expect(ChatStreamStore.isStreaming(sessionId)).toBe(true);
		expect(chipState()).toBe("silent");
		expect(chipLabel()).toBe("NO SIGNAL");
		expect(chipDotStill()).toBe(true);
	});

	it("still reports WORKING on an adopted turn whose server is beating", () => {
		// The inverse of the case above: no content clock either, but the op is
		// alive. Treating "no content clock" as silent outright would be the same
		// lie in the other direction.
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-1" });
		ChatStreamStore.adoptTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId,
			{ type: "op_heartbeat", opId: "op-1", phase: "reasoning" });
		vi.advanceTimersByTime(SIGNAL_TICK_MS);

		expect(ChatStreamStore.get(sessionId).lastContentMs).toBe(0);
		expect(chipState()).toBe("working");
		expect(chipLabel()).toBe("WORKING · THINKING");
	});

	it("parks the heartbeat's turn shape on the store's own entry", () => {
		// ChatStreamStore exists because five parallel per-session maps drifted
		// apart. The beat that NAMES what a content-idle turn is doing is
		// per-session server state, so it rides the entry the store already owns
		// and already prunes — a sixth sessionId-keyed map in a themed-phrases
		// file would be the same bug in a new hat.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "chat_op_started", opId: "op-1" });
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ageContent(30_000);
		ChatStreamStore.applyEvent(sessionId,
			{ type: "op_heartbeat", opId: "op-1", activeTool: "build_app" });
		expect(chipLabel()).toBe("WORKING · BUILD_APP");

		const entry = ChatStreamStore.get(sessionId) as unknown as Record<string, { activeTool?: string }>;
		const parked = Object.keys(entry).filter(k => entry[k] && entry[k].activeTool === "build_app");
		expect(parked).toHaveLength(1);

		// And whatever the store forgets, the label forgets with it.
		entry[parked[0]] = null as unknown as { activeTool?: string };
		vi.advanceTimersByTime(SIGNAL_TICK_MS);
		expect(chipLabel()).toBe("WORKING");
	});

	it("recovers the moment output resumes", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "checking" });
		ageWholeTurn(120_000);
		vi.advanceTimersByTime(SIGNAL_TICK_MS);
		expect(chipState()).toBe("silent");

		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: " back" });
		expect(chipState()).toBe("flowing");
		expect(chipLabel()).toBe("STREAMING");
		expect(chipDotStill()).toBe(false);
	});
});

describe("thinking phrase ↔ real stream signal", () => {
	it("rotates while work is provably happening", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "on it" });
		const live = renderLiveBubble();

		const first = phraseOf(live);
		expect(live.dataset.signal).toBe("flowing");
		vi.advanceTimersByTime(PHRASE_TICK_MS);

		// pick() never returns the phrase it was given, so a rotation always
		// changes the text — motion here means the stream is moving.
		expect(phraseOf(live)).not.toBe(first);
		expect(stillOf(live)).toBe(false);
	});

	it("freezes on the silence line — and STAYS frozen — when nothing is arriving", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "on it" });
		const live = renderLiveBubble();

		ageWholeTurn(120_000);
		vi.advanceTimersByTime(PHRASE_TICK_MS);
		expect(live.dataset.signal).toBe("silent");
		expect(phraseOf(live)).toBe("Radio silence");
		expect(stillOf(live)).toBe(true);

		// The blind timer would have cycled three more phrases by here.
		vi.advanceTimersByTime(PHRASE_TICK_MS * 3);
		expect(phraseOf(live)).toBe("Radio silence");
		expect(stillOf(live)).toBe(true);
	});

	it("never spreads the viewed chat's silence onto another surface's bubble", async () => {
		// The signal is derived for ONE turn — the one in the chat on screen.
		// A voice reply runs on its own WS (chat-voice-ws-handler.js renders the
		// same markup on agent_start) and can be actively working while the main
		// chat's turn is wedged. Freezing it to 'Radio silence' is the identical
		// lie this chunk exists to remove, just pointed the other way.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "on it" });
		const live = renderLiveBubble();
		ageWholeTurn(120_000);
		vi.advanceTimersByTime(PHRASE_TICK_MS);
		expect(phraseOf(live)).toBe("Radio silence");

		// thinkingHTML bakes the viewed chat's state because it returns a STRING
		// and cannot see where it will be attached; once innerHTML has run the
		// surface is knowable, and the correction lands on a microtask — before
		// the browser's next paint, so the wrong label is never on screen.
		const voice = renderVoiceBubble();
		await Promise.resolve();
		expect(voice.dataset.signal).toBe("off");
		expect(phraseOf(voice)).not.toBe("Radio silence");
		expect(stillOf(voice)).toBe(false);

		// …and it keeps rotating while the main chat stays frozen.
		const before = phraseOf(voice);
		vi.advanceTimersByTime(PHRASE_TICK_MS);
		expect(phraseOf(voice)).not.toBe(before);
		expect(stillOf(voice)).toBe(false);
		expect(phraseOf(live)).toBe("Radio silence");
		expect(stillOf(live)).toBe(true);
	});

	it("bakes the silent state into freshly built markup", () => {
		// The live bubble is destroyed and rebuilt on every WS event, so a
		// rebuild during a silent stretch must not flash a working indicator.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "on it" });
		ageWholeTurn(120_000);

		const html = win().thinkingHTML();
		expect(html).toContain('data-signal="silent"');
		expect(html).toContain("Radio silence");
		expect(html).toContain('style="animation:none"');
	});

	it("keeps rotating for indicators with no live turn behind them", () => {
		// A worker bubble or an IDE surface while the viewed chat is idle: the
		// signal says 'off' and this file has no business freezing it.
		doc().getElementById("messages")!.innerHTML = win().thinkingHTML();
		expect(thinking().dataset.signal).toBe("off");

		const first = phrase();
		vi.advanceTimersByTime(PHRASE_TICK_MS);
		expect(phrase()).not.toBe(first);
		expect(dotsStill()).toBe(false);
	});
});

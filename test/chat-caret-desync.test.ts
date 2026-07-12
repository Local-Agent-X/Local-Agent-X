// @vitest-environment happy-dom
//
// Regression: a turn finished server-side but the chat stayed frozen mid-turn —
// the blinking streaming caret (.msg-body.streaming::after) kept blinking while
// the composer/stop-button read idle. The caret was torn down in exactly ONE
// place: the one-shot per-turn finalize (_finalizeWsTurn → finalizeLiveMessage-
// InPlace). That finalize early-returns before stripping the caret whenever
// promoteLiveToMessages returns null — which it does for a redundant/replayed
// `done` (the store clears its live scratch after the first promote). The
// stuck-stream watchdog and reconnect_op both replay `done`, so the recovery
// path itself flipped the pill/stop idle (they re-assert on every store mutation
// via updateStreamUI) yet left the caret alive until a page refresh.
//
// Fix: fold the caret into that same store-driven reconciler. updateStreamUI is
// bound to ChatStreamStore.subscribeAll, so once this view's status leaves
// 'streaming' it strips `.streaming` from #messages — idempotent, self-healing,
// and independent of whether the one-shot finalize ran. This test drives the
// REAL updateStreamUI wiring (both source files loaded, no copies) and asserts
// the caret's lifecycle tracks isStreaming exactly.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

interface Store {
	startTurn(sessionId: string, anchorIdx?: number): unknown;
	applyEvent(sessionId: string, event: { type: string; delta?: string }): void;
	isStreaming(sessionId: string): boolean;
}

const sessionId = "chat-caret";
let ChatStreamStore: Store;

function caretPresent(): boolean {
	const g = globalThis as unknown as { document: Document };
	return !!g.document.querySelector("#messages .msg-body.streaming");
}

beforeEach(() => {
	const g = globalThis as unknown as {
		window: { ChatStreamStore: Store; isStreaming: Store["isStreaming"]; activeChat: { id: string } };
		document: Document;
		ChatStreamStore: Store;
	};

	// Load the real store IIFE fresh so its internal Map + subscriber set start
	// empty (it closes over module state with no reset hook).
	// eslint-disable-next-line no-new-func
	new Function(readFileSync(join(here, "../public/js/chat-stream-store.js"), "utf8"))();
	ChatStreamStore = g.window.ChatStreamStore;

	// chat-uploads.js registers its subscriber via a bare `ChatStreamStore`
	// reference inside a try/catch — pin it as a global so the wiring actually
	// runs (a swallowed catch would make this test pass for the wrong reason).
	g.ChatStreamStore = ChatStreamStore;
	// Mirror chat.js:13 (window.isStreaming = store.isStreaming) and the active
	// view updateStreamUI reconciles against.
	g.window.isStreaming = ChatStreamStore.isStreaming;
	g.window.activeChat = { id: sessionId };

	// A live assistant bubble already wearing the streaming affordance.
	g.document.body.innerHTML =
		'<div id="messages"><div class="msg assistant"><div class="msg-body streaming"></div></div></div>';

	// Load the real reconciler: defines updateStreamUI and binds it to
	// ChatStreamStore.subscribeAll so every store mutation re-evaluates the view.
	// eslint-disable-next-line no-new-func
	new Function(readFileSync(join(here, "../public/js/chat-uploads.js"), "utf8"))();
});

describe("streaming caret ↔ isStreaming reconciliation", () => {
	it("keeps the caret while the turn is streaming", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "working" });
		expect(ChatStreamStore.isStreaming(sessionId)).toBe(true);
		expect(caretPresent()).toBe(true);
	});

	it("strips the caret on terminal done — no orphaned affordance", () => {
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "working" });
		ChatStreamStore.applyEvent(sessionId, { type: "done" });
		expect(ChatStreamStore.isStreaming(sessionId)).toBe(false);
		expect(caretPresent()).toBe(false);
	});

	it("self-heals: a re-stranded caret is cleared by any later store mutation", () => {
		// Turn ends cleanly.
		ChatStreamStore.startTurn(sessionId, 0);
		ChatStreamStore.applyEvent(sessionId, { type: "stream", delta: "done." });
		ChatStreamStore.applyEvent(sessionId, { type: "done" });
		expect(caretPresent()).toBe(false);

		// Simulate the field bug's stranding: something re-adds `.streaming` to the
		// finalized bubble (a finalize path that bailed, a stray rerender). The
		// reconciler must not depend on the one-shot finalize to fix it — the next
		// store mutation (here the watchdog-replayed redundant `done`) reconciles
		// the view back to its non-streaming truth.
		const g = globalThis as unknown as { document: Document };
		g.document.querySelector("#messages .msg-body")!.classList.add("streaming");
		expect(caretPresent()).toBe(true);

		ChatStreamStore.applyEvent(sessionId, { type: "done" });
		expect(caretPresent()).toBe(false);
	});
});

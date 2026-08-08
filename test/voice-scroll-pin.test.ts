// @vitest-environment happy-dom
//
// Regression: during voice chat the conversation vanished above the fold.
//
// The previous reply's assistant bubble keeps `.pin-bottom` (a ~100vh empty
// reservation, app.css) after its turn ends. The next spoken utterance was
// appended BELOW that reservation, and the handler's pin-to-top
// scrollIntoView clamped at max-scroll because the utterance was the last
// element — so the visible screen was the stale empty reservation and the
// whole thread sat above the viewport until the user manually scrolled up.
// agent_start then created the new reserved bubble (finally making room
// below) but never re-pinned, so the reply also streamed below the fold.
//
// Fix (chat-voice-ws-handler.js), mirroring chat-send.js's typed-turn order:
//   1. strip the stale pin-bottom before building the new user bubble
//      (partial-create and no-partial final paths);
//   2. remember the committed utterance element (voiceLastUserEl);
//   3. on agent_start — once addMessageEl has migrated pin-bottom onto the
//      new assistant bubble and room exists — rAF-re-pin the utterance to
//      the top of the scroller.
//
// This drives the REAL handler source; addMessageEl is a minimal stand-in
// mirroring only the DOM shape + pin migration chat-helpers.js performs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HANDLER_SRC = readFileSync(join(here, "../public/js/chat-voice-ws-handler.js"), "utf8");

function loadHandler(): void {
	// Function declarations inside new Function() stay local — re-export the
	// handler; its free-variable state reads/writes resolve to window globals.
	// eslint-disable-next-line no-new-func
	new Function(HANDLER_SRC + "\nwindow.handleVoiceWsMessage = handleVoiceWsMessage;")();
}

function fire(msg: Record<string, unknown>): void {
	(window as any).handleVoiceWsMessage({ data: JSON.stringify(msg) });
}

beforeEach(() => {
	document.body.innerHTML = `
		<div id="messages">
			<div class="msg user"><div class="msg-label">You</div><div class="msg-body">earlier prompt</div></div>
			<div class="msg assistant pin-bottom"><div class="msg-label">Assistant</div><div class="msg-body">earlier reply</div></div>
		</div>`;
	// Shared script-global voice state normally declared in chat-voice.js.
	(window as any).dictateMode = false;
	(window as any).voicePartialEl = null;
	(window as any).voiceLastUserEl = null;
	(window as any).voiceCurrentMsgEl = null;
	(window as any).voiceCurrentMsgBody = null;
	(window as any).voiceCurrentMsgText = "";
	(window as any).voicePlaybackNode = null;
	(window as any).isListening = false;
	(window as any).isSpeaking = false;
	(window as any).activeChat = null;
	(window as any).updateVoiceUI = vi.fn();
	(window as any).appendDictatedText = vi.fn();
	(window as any).thinkingHTML = () => "<span>thinking</span>";
	// Deterministic rAF so the agent_start re-pin runs inline.
	(window as any).requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
	// Stand-in for chat-helpers.js addMessageEl: append the bubble and, for
	// assistant rows, migrate pin-bottom — the two behaviors the handler
	// choreography depends on.
	(window as any).addMessageEl = (role: string, text: string) => {
		const el = document.getElementById("messages")!;
		const div = document.createElement("div");
		div.className = "msg " + role;
		div.innerHTML = `<div class="msg-label"></div><div class="msg-body"></div>`;
		div.querySelector(".msg-body")!.textContent = text;
		el.appendChild(div);
		if (role === "assistant") {
			document.querySelectorAll(".msg.assistant.pin-bottom").forEach(m => m.classList.remove("pin-bottom"));
			div.classList.add("pin-bottom");
		}
		return div;
	};
	loadHandler();
});

describe("voice chat scroll pin", () => {
	it("strips the previous reply's stale pin-bottom when a live partial bubble is created", () => {
		fire({ type: "partial", text: "hey what's" });
		const stale = document.querySelectorAll(".msg.assistant.pin-bottom");
		expect(stale.length).toBe(0);
		const partial = document.querySelector(".msg.user.voice-partial");
		expect(partial).not.toBeNull();
		expect(partial!.querySelector(".msg-body")!.textContent).toBe("hey what's");
	});

	it("strips the stale pin on a final that arrives without a preceding partial", () => {
		fire({ type: "final", text: "hey what's the weather" });
		expect(document.querySelectorAll(".msg.assistant.pin-bottom").length).toBe(0);
		expect((window as any).voiceLastUserEl).not.toBeNull();
		expect((window as any).voiceLastUserEl.querySelector(".msg-body").textContent).toBe("hey what's the weather");
	});

	it("finalizes the partial in place and records it as the pin target", () => {
		fire({ type: "partial", text: "hey what's" });
		const partial = document.querySelector(".msg.user.voice-partial");
		fire({ type: "final", text: "hey what's the weather" });
		expect((window as any).voiceLastUserEl).toBe(partial);
		expect(partial!.classList.contains("voice-partial")).toBe(false);
		expect(partial!.querySelector(".msg-body")!.textContent).toBe("hey what's the weather");
	});

	it("re-pins the utterance to the top on agent_start, after the reserved bubble exists", () => {
		fire({ type: "final", text: "hey what's the weather" });
		const userEl = (window as any).voiceLastUserEl as HTMLElement;
		const scrollSpy = vi.fn();
		userEl.scrollIntoView = scrollSpy;

		fire({ type: "agent_start" });

		// New assistant bubble carries the migrated reservation…
		const pinned = document.querySelectorAll(".msg.assistant.pin-bottom");
		expect(pinned.length).toBe(1);
		expect(pinned[0]).toBe((window as any).voiceCurrentMsgEl);
		// …and the utterance was re-pinned to the top now that room exists.
		expect(scrollSpy).toHaveBeenCalledWith({ block: "start" });
	});

	it("removes an orphaned live-partial bubble when the agent turn starts", () => {
		// A stray partial (speaker echo / decoder noise) arriving after the
		// final creates a fresh preview bubble; agent_start must clear it so
		// it doesn't sit blinking next to the streaming reply.
		fire({ type: "final", text: "hey what's the weather" });
		fire({ type: "partial", text: "SSION" });
		expect(document.querySelector(".msg.user.voice-partial")).not.toBeNull();

		fire({ type: "agent_start" });
		expect(document.querySelector(".msg.user.voice-partial")).toBeNull();
		expect((window as any).voicePartialEl).toBeNull();
	});

	it("does not touch the thread pin in dictate mode", () => {
		(window as any).dictateMode = true;
		fire({ type: "final", text: "dictated text, not a chat turn" });
		expect(document.querySelectorAll(".msg.assistant.pin-bottom").length).toBe(1);
		expect((window as any).voiceLastUserEl).toBeNull();
	});
});

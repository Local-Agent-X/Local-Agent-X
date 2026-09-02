// Peter-approved invariant: background jobs never interrupt the user.
//
// A failed dream (memory_consolidation) op's bg_op_completed rides the GLOBAL
// bg_op_* fan-out into every client's handleBgOpCompleted, which raised an OS
// toast (window.desktop.showNotification) and — when no card existed — minted
// a typeless fallback card that partitions into the MAIN agents feed as an
// interrupting "Worker … failed" card. The event itself must keep flowing:
// it is the ONLY thing that flips the ambient dock card out of "dreaming",
// writes the failure trace into its fold body, and arms the 30-min prune.
//
// So the server stamps `headless: true` on bg_op_completed (derived from the
// ONE predicate, src/chat-ws/state.ts isHeadlessSession — see
// session-bridge-observer.ts) and the client skips toast + fallback card on
// that stamp while still applying the updateAgentFeed dock update. These
// tests pin both halves of the client decision: headless → dock-only;
// real ops → byte-same toast and card as before.
//
// chat-ws-handler-bg-ops.js is a classic browser global-script, so — like
// chat-ws-process-relay.test.ts — its source is evaluated in a Function
// factory with the globals it reaches for passed in as parameters.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const bgSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler-bg-ops.js"), "utf8");

function loadBgOps() {
	const addAgentFeed = vi.fn();
	const updateAgentFeed = vi.fn();
	const removeAgentFeed = vi.fn();
	const showNotification = vi.fn();
	const setTimeoutSpy = vi.fn();
	const factory = new Function(
		"addAgentFeed", "updateAgentFeed", "removeAgentFeed", "setTimeout", "showNotification",
		`
		var window = { desktop: { showNotification: showNotification } };
		var activeChat = null;
		var ChatStreamStore = { setSidebarActive: function() {} };
		var renderSidebar = function() {};
		${bgSource}
		return { dispatchBgOpEventChecked: dispatchBgOpEventChecked };
		`,
	);
	const api = factory(addAgentFeed, updateAgentFeed, removeAgentFeed, setTimeoutSpy, showNotification) as {
		dispatchBgOpEventChecked: (msg: unknown) => boolean | null;
	};
	return { ...api, addAgentFeed, updateAgentFeed, removeAgentFeed, showNotification, setTimeoutSpy };
}

function completedMsg(overrides: Record<string, unknown> = {}, sessionId = "chat-1") {
	return {
		sessionId,
		event: {
			type: "bg_op_completed",
			opId: "op-x",
			status: "failed",
			summary: "consolidation crashed",
			filesChanged: [],
			...overrides,
		},
	};
}

describe("handleBgOpCompleted — headless completions never toast or interrupt (dock only)", () => {
	it("a FAILED dream op (headless:true): no OS toast, no fallback card, dock update still lands", () => {
		const h = loadBgOps();
		const handled = h.dispatchBgOpEventChecked(completedMsg({ opId: "op-dream-1", headless: true }, "dream-123"));

		expect(handled).toBe(true);
		expect(h.showNotification).not.toHaveBeenCalled();
		// No typeless fallback card — that card partitions into the MAIN feed
		// as an interrupting "Worker … failed" card.
		expect(h.addAgentFeed).not.toHaveBeenCalled();
		// The ambient dock card (minted by bg_op_queued/started with opType)
		// still receives its terminal update, byte-same output.
		expect(h.updateAgentFeed).toHaveBeenCalledWith("op-dream-1", {
			status: "failed",
			output: "consolidation crashed",
		});
		// The 30-min prune is still armed so the dock card clears itself.
		expect(h.setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30 * 60 * 1000);
	});

	it("a SUCCEEDED headless op does not toast either — the invariant is session-, not status-derived", () => {
		const h = loadBgOps();
		h.dispatchBgOpEventChecked(completedMsg({ status: "completed", summary: "memories consolidated", headless: true }, "dream-456"));

		expect(h.showNotification).not.toHaveBeenCalled();
		expect(h.addAgentFeed).not.toHaveBeenCalled();
		expect(h.updateAgentFeed).toHaveBeenCalledWith("op-x", {
			status: "completed",
			output: "memories consolidated",
		});
	});

	it("a failed REAL op keeps its toast and card byte-identical to before", () => {
		const h = loadBgOps();
		h.dispatchBgOpEventChecked(completedMsg({ opId: "op-real-1", summary: "provider 500", filesChanged: ["a.ts"] }));

		// Fallback card ensured first (defense in depth), then the state flip.
		expect(h.addAgentFeed).toHaveBeenCalledWith({
			id: "op-real-1",
			name: "Worker: op-real-1",
			role: "coder",
			status: "failed",
			output: "",
		});
		expect(h.updateAgentFeed).toHaveBeenCalledWith("op-real-1", {
			status: "failed",
			output: "provider 500\n\nfiles: a.ts",
		});
		expect(h.showNotification).toHaveBeenCalledTimes(1);
		expect(h.showNotification).toHaveBeenCalledWith("Worker finished", "provider 500");
	});

	it("a completed REAL op with a resultUrl is unchanged too", () => {
		const h = loadBgOps();
		h.dispatchBgOpEventChecked(completedMsg({ opId: "op-real-2", status: "completed", summary: "done", resultUrl: "/api/x" }));

		expect(h.updateAgentFeed).toHaveBeenCalledWith("op-real-2", {
			status: "completed",
			output: "done",
			resultUrl: "/api/x",
		});
		expect(h.showNotification).toHaveBeenCalledWith("Worker finished", "done");
	});
});

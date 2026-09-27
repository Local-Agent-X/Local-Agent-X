// @vitest-environment happy-dom
//
// The learning notice is how a chat learns that the post-turn review proposed
// a workflow from it. The proposal is a draft until the user keeps it, so the
// notice only works if it is seen and if Keep / Discard reach the learning
// route: it lands on the saved row after the turn, it is not added twice when
// the snapshot re-delivers it, and its buttons post the right actions.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
const g = globalThis as unknown as Record<string, unknown>;

type Notice = {
	kind: string; id: string; candidateId: string; versionId: string; name: string; description: string;
	refinement: boolean; canReject: boolean; expectedActiveVersionId: string | null; status: string; error?: string;
};

const CANDIDATE = "learned-0123456789abcdefabcd";
const VERSION = "22222222-2222-4222-8222-222222222222";
const ACTIVE = "11111111-1111-4111-8111-111111111111";

function event(over: Record<string, unknown> = {}) {
	return {
		type: "learning_notice", id: CANDIDATE, versionId: VERSION, name: "thriveventory_purchase_order",
		description: "Create a PO from an invoice", refinement: false, canReject: true, expectedActiveVersionId: null, ...over,
	};
}

function load(): { renderLearningNotice: (n: Notice) => HTMLElement; attachLearningNotices: (sid: string, evs: unknown[]) => boolean } {
	g.esc = (s: string) => String(s).replace(/</g, "&lt;");
	const renderer = new Function(src("chat-render-notices.js") + "\nreturn { renderLearningNotice };")() as { renderLearningNotice: (n: Notice) => HTMLElement };
	const attacher = new Function(src("chat-learning-notices.js") + "\nreturn { attachLearningNotices };")() as { attachLearningNotices: (sid: string, evs: unknown[]) => boolean };
	return { ...renderer, ...attacher };
}

function notice(over: Partial<Notice> = {}): Notice {
	return {
		kind: "learning", id: `ln-${CANDIDATE}-${VERSION}`, candidateId: CANDIDATE, versionId: VERSION,
		name: "thriveventory_purchase_order", description: "Create a PO from an invoice",
		refinement: false, canReject: true, expectedActiveVersionId: null, status: "pending", ...over,
	};
}

function mockRoute(status = 200) {
	const posted: Array<{ path: string; body: unknown }> = [];
	g.apiFetch = vi.fn(async (path: string, opts: { body: string }) => {
		posted.push({ path, body: JSON.parse(opts.body) });
		return { ok: status < 400, status, json: async () => ({}) };
	});
	g.saveChats = vi.fn();
	return posted;
}

describe("the learning notice on a chat", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		delete g.chats;
		delete g.activeChat;
	});

	it("says what was learned and offers Keep and Discard", () => {
		const el = load().renderLearningNotice(notice());
		expect(el.textContent).toContain("Learned a workflow: thriveventory_purchase_order");
		expect(el.textContent).toContain("Create a PO from an invoice");
		expect(el.querySelector(".learning-notice-keep")).not.toBeNull();
		expect(el.querySelector(".learning-notice-discard")).not.toBeNull();
	});

	it("Keep posts activate for the proposed version and remembers it on the row", async () => {
		const posted = mockRoute();
		const n = notice();
		const el = load().renderLearningNotice(n);
		(el.querySelector(".learning-notice-keep") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(n.status).toBe("kept"));
		expect(posted).toEqual([{ path: `/api/memory/learning/${CANDIDATE}/action`, body: { action: "activate", versionId: VERSION, expectedActiveVersionId: null } }]);
		expect(g.saveChats).toHaveBeenCalled();
		expect(el.textContent).toContain("Kept");
		expect(el.querySelector(".learning-notice-keep")).toBeNull();
	});

	it("Discard posts reject for a new procedure", async () => {
		const posted = mockRoute();
		const n = notice();
		const el = load().renderLearningNotice(n);
		(el.querySelector(".learning-notice-discard") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(n.status).toBe("discarded"));
		expect(posted[0].body).toEqual({ action: "reject" });
	});

	it("for a new version of a workflow in use, Keep carries the live version and Discard only dismisses", async () => {
		const posted = mockRoute();
		const n = notice({ refinement: true, canReject: false, expectedActiveVersionId: ACTIVE });
		const { renderLearningNotice } = load();
		const el = renderLearningNotice(n);
		expect(el.textContent).toContain("Refined a learned workflow");
		(el.querySelector(".learning-notice-discard") as HTMLButtonElement).click();
		expect(n.status).toBe("dismissed");
		expect(posted).toHaveLength(0);

		const again = notice({ refinement: true, canReject: false, expectedActiveVersionId: ACTIVE });
		const el2 = renderLearningNotice(again);
		(el2.querySelector(".learning-notice-keep") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(again.status).toBe("kept"));
		expect(posted[0].body).toEqual({ action: "activate", versionId: VERSION, expectedActiveVersionId: ACTIVE });
	});

	it("a stale version says so and keeps the buttons", async () => {
		mockRoute(409);
		const n = notice();
		const el = load().renderLearningNotice(n);
		(el.querySelector(".learning-notice-keep") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(el.textContent).toContain("changed since"));
		expect(n.status).toBe("pending");
		expect(el.querySelector(".learning-notice-keep")).not.toBeNull();
	});
});

describe("the notice attaches to the saved conversation, once", () => {
	it("lands on the latest assistant row, and a re-delivery does not duplicate it", () => {
		const { attachLearningNotices } = load();
		const chat = { id: "sess-1", messages: [
			{ role: "user", content: "file the PO" },
			{ role: "assistant", content: "Done." },
			{ role: "user", content: "that worked" },
			{ role: "assistant", content: "Great." },
		] as Array<Record<string, unknown>> };
		g.chats = [chat];
		g.saveChats = vi.fn();
		g.renderMessages = vi.fn();
		g.activeChat = chat;

		expect(attachLearningNotices("sess-1", [event()])).toBe(true);
		attachLearningNotices("sess-1", [event()]);
		const last = chat.messages[3]._notices as Notice[];
		expect(last).toHaveLength(1);
		expect(last[0]).toMatchObject({ kind: "learning", candidateId: CANDIDATE, versionId: VERSION, status: "pending", canReject: true });
		expect(chat.messages[1]._notices).toBeUndefined();
		expect(g.saveChats).toHaveBeenCalledTimes(1);
		expect(g.renderMessages).toHaveBeenCalledTimes(1);
	});

	it("does nothing for a chat this window has not loaded", () => {
		const { attachLearningNotices } = load();
		g.chats = [];
		expect(attachLearningNotices("sess-unknown", [event()])).toBe(false);
	});

	it("renders through the row notice list beside delete notices", () => {
		const artifacts = src("chat-render-artifacts.js");
		expect(artifacts).toContain("n.kind === 'learning' ? renderLearningNotice(n) : renderDeleteNotice(n)");
		const handler = src("chat-ws-handler.js");
		expect(handler).toContain("attachLearningNotices(msg.sessionId, [msg.event])");
		expect(handler).toContain("attachLearningNotices(sessionId, msg.learningNotices)");
		expect(readFileSync(join(here, "../public/app.html"), "utf8")).toContain('<script src="/js/chat-learning-notices.js');
	});
});

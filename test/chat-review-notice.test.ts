// @vitest-environment happy-dom
//
// The review notice is how pre-publish review findings reach the user when a
// publish ran: in chat-mvfaq00w (2026-10-21) the model pushed past an AMBER
// review and its reply never mentioned the findings. So: it names every
// finding, it lands on the turn once, and it survives finalize onto the row.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
const g = globalThis as unknown as Record<string, unknown>;

type Finding = { severity: string; location: string; problem: string; fix: string };
type Notice = { id: string; kind: string; status: string; summary: string; findings: Finding[] };

const event = {
	type: "review_notice",
	toolCallId: "push1",
	status: "AMBER",
	summary: "1 commit, 4 files — git push origin main",
	findings: [
		{ severity: "amber", location: "apps/mobile/login.tsx:140", problem: "The phone_required branch probably never runs.", fix: "Check what Auth returns." },
		{ severity: "yellow", location: "supabase/migrations/x.sql:66", problem: "A signup with no phone key skips the check.", fix: "Exempt staff by a flag." },
	],
};

function loadRenderer(): (n: Notice) => HTMLElement {
	g.esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
	return (new Function(src("chat-render-notices.js") + "\nreturn { renderReviewNotice };")() as { renderReviewNotice: (n: Notice) => HTMLElement }).renderReviewNotice;
}

describe("the review notice on a turn", () => {
	beforeEach(() => { document.body.innerHTML = ""; });

	it("says it shipped, and lists every finding with its location and fix", () => {
		const el = loadRenderer()({ id: "rn-push1", kind: "review", status: "AMBER", summary: event.summary, findings: event.findings });
		expect(el.classList.contains("review-notice-amber")).toBe(true);
		expect(el.textContent).toContain("Pre-publish review: AMBER — 2 findings");
		expect(el.textContent).toContain("It shipped");
		expect(el.querySelectorAll(".review-notice-finding")).toHaveLength(2);
		expect(el.textContent).toContain("apps/mobile/login.tsx:140");
		expect(el.textContent).toContain("Fix: Exempt staff by a flag.");
	});

	it("escapes what the reviewer wrote", () => {
		const el = loadRenderer()({ id: "rn-x", kind: "review", status: "AMBER", summary: "", findings: [{ severity: "amber", location: "a.ts:1", problem: "<img src=x onerror=alert(1)>", fix: "" }] });
		expect(el.querySelector("img")).toBeNull();
	});
});

describe("review_notice rides the stream store onto the saved row", () => {
	it("lands on the turn once, and finalize keeps it on the message", () => {
		for (const f of ["agentxos-timeline.js", "chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
			new Function(src(f))();
		}
		const store = (g.window as { ChatStreamStore: Record<string, (...a: unknown[]) => unknown> }).ChatStreamStore;
		const sid = "sess-review-notice";
		store.startTurn(sid, 0);
		store.applyEvent(sid, { type: "stream", delta: "Pushed." });
		store.applyEvent(sid, event);
		store.applyEvent(sid, event);
		const entry = store.get(sid) as { notices: Notice[] };
		expect(entry.notices).toHaveLength(1);
		expect(entry.notices[0]).toMatchObject({ id: "rn-push1", kind: "review", status: "AMBER" });
		store.applyEvent(sid, { type: "done" });
		const msg = store.promoteLiveToMessages(sid, { messages: [] }) as { _notices: Notice[] };
		expect(msg._notices[0]).toMatchObject({ kind: "review", findings: event.findings });
	});
});

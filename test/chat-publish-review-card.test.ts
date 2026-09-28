// @vitest-environment happy-dom
//
// A publish ask (git push / deploy / package publish / release) carries the
// fresh-context review of what would ship as a typed preview
// (src/tool-execution/publish-review-text.ts reviewPreview →
// approval_requested.preview). The card must show it — verdict chip, what was
// reviewed, every finding — and on RED the approve button must say what it
// does ("Push anyway"). Model-written finding text is rendered as text, never
// HTML. Drives the REAL client sources through happy-dom with the same
// `new Function` harness as chat-approval-card-lifecycle.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");

type RenderApproval = (ap: Record<string, unknown>) => HTMLElement;
interface Store {
	startTurn(sessionId: string, anchorIdx?: number): unknown;
	applyEvent(sessionId: string, event: Record<string, unknown>): void;
	get(sessionId: string): { approvals: Array<Record<string, unknown>> } | null;
}

let renderApproval: RenderApproval;
let store: Store;

function load() {
	const g = globalThis as unknown as Record<string, unknown>;
	g.esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
	g.makeApprovalCard = (new Function(src("chat-tool-cards.js") + "\nreturn { makeApprovalCard };")() as Record<string, unknown>).makeApprovalCard;
	g.applyPublishReview = (new Function(src("chat-render-publish-review.js") + "\nreturn { applyPublishReview };")() as Record<string, unknown>).applyPublishReview;
	renderApproval = (new Function(src("chat-render-approvals.js") + "\nreturn { renderApproval };")() as { renderApproval: RenderApproval }).renderApproval;
	for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-stream-finalize.js"]) new Function(src(f))();
	store = (g.window as { ChatStreamStore: Store }).ChatStreamStore;
	g.ChatStreamStore = store;
}

const RED_PREVIEW = {
	kind: "publish-review",
	status: "RED",
	command: "git push origin feature",
	summary: "3 commits, 4 files — git push origin feature from /repo",
	findings: [
		{ severity: "red", location: "supabase/migrations/0042_email_rls.sql:12", problem: "policy lets any member read every recipient email", why: "0031 fixed the same hole for sms_*", fix: "scope to auth.uid()" },
		{ severity: "amber", location: "src/dedupe.ts:40", problem: "<img src=x onerror=alert(1)> racy 24h check", why: "double sends", fix: "unique constraint" },
	],
	overrideLabel: "Push anyway",
};

function live(preview: Record<string, unknown> | null) {
	return { id: `ap-${Math.random()}`, toolName: "bash", context: "⛔ review", argsPreview: '{"command":"git push"}', status: "pending", rememberable: false, preview };
}

beforeEach(() => {
	document.body.innerHTML = "";
	load();
});

describe("publish review on the approval card", () => {
	it("RED: verdict chip, every finding, and the override wording on the approve button", () => {
		const card = renderApproval(live(RED_PREVIEW));
		expect(card.querySelector(".publish-review-chip")?.textContent).toBe("RED — do not ship");
		expect(card.querySelector(".publish-review-command")?.textContent).toBe("git push origin feature");
		const findings = [...card.querySelectorAll(".publish-review-finding")];
		expect(findings).toHaveLength(2);
		expect(findings[0].querySelector(".publish-review-loc")?.textContent).toBe("supabase/migrations/0042_email_rls.sql:12");
		expect(findings[0].querySelector(".publish-review-fix")?.textContent).toBe("Fix: scope to auth.uid()");
		const approve = card.querySelector(".btn-approve");
		expect(approve?.textContent).toBe("Push anyway");
		expect(approve?.classList.contains("override")).toBe(true);
		// The review sits above the decision, and it adds no controls of its own.
		const actions = card.querySelector(".approval-actions")!;
		expect(card.querySelector(".publish-review")!.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(card.querySelectorAll("button")).toHaveLength(2);
	});

	it("renders model-written finding text as text, never HTML", () => {
		const card = renderApproval(live(RED_PREVIEW));
		expect(card.querySelector("img")).toBeNull();
		expect(card.querySelectorAll(".publish-review-problem")[1].textContent).toContain("<img src=x");
	});

	it("FAILED says it was not reviewed and the approve button says what approving means", () => {
		const card = renderApproval(live({ kind: "publish-review", status: "FAILED", command: "vercel --prod", summary: "", findings: [], reason: "the review ran past its 4-minute deadline", overrideLabel: "Deploy unreviewed" }));
		expect(card.querySelector(".publish-review-chip")?.textContent).toBe("FAILED — not reviewed");
		expect(card.querySelector(".publish-review-reason")?.textContent).toContain("deadline");
		expect(card.querySelector(".btn-approve")?.textContent).toBe("Deploy unreviewed");
	});

	it("an ask without a publish review is the ordinary card", () => {
		const card = renderApproval(live(null));
		expect(card.querySelector(".publish-review")).toBeNull();
		expect(card.querySelector(".btn-approve")?.textContent).toBe("Approve");
	});

	it("the stream store keeps the ask's preview so a re-render still shows the review", () => {
		store.startTurn("s-pr");
		store.applyEvent("s-pr", { type: "approval_requested", approvalId: "apr-9", toolName: "bash", context: "c", argsPreview: "{}", preview: RED_PREVIEW });
		expect(store.get("s-pr")?.approvals[0].preview).toEqual(RED_PREVIEW);
	});
});

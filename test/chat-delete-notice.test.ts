// @vitest-environment happy-dom
//
// The delete notice is what stands in for the card when the agent deletes, to
// the trash, files this request created that the user did not name. It is only
// safe if it is seen and if Undo works — so: it lands on the turn, it survives
// finalize onto the saved row, and Undo restores through the server route.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");
const g = globalThis as unknown as Record<string, unknown>;

type Notice = { id: string; files: string[]; restored: boolean; error?: string };

function loadNoticeRenderer(): (n: Notice) => HTMLElement {
	g.esc = (s: string) => String(s).replace(/</g, "&lt;");
	return (new Function(src("chat-render-notices.js") + "\nreturn { renderDeleteNotice };")() as { renderDeleteNotice: (n: Notice) => HTMLElement }).renderDeleteNotice;
}

describe("the delete notice on a turn", () => {
	beforeEach(() => { document.body.innerHTML = ""; });

	it("names each file and offers Undo", () => {
		const el = loadNoticeRenderer()({ id: "dn-r1", files: ["C:\\w\\ns_tmp.json", "C:\\w\\ns_tmp.txt"], restored: false });
		expect(el.textContent).toContain("Deleted 2 files");
		expect(el.textContent).toContain("ns_tmp.json");
		expect(el.textContent).toContain("in the trash");
		expect(el.querySelector(".delete-notice-undo")).not.toBeNull();
	});

	it("Undo posts the paths to /api/trash/restore, then shows Restored and remembers it on the row", async () => {
		const posted: unknown[] = [];
		g.apiFetch = vi.fn(async (_path: string, opts: { body: string }) => {
			posted.push(JSON.parse(opts.body));
			return { ok: true, json: async () => ({ results: [{ path: "C:\\w\\ns_tmp.json", restored: "C:\\w\\ns_tmp.json" }] }) };
		});
		g.saveChats = vi.fn();
		const notice: Notice = { id: "dn-r1", files: ["C:\\w\\ns_tmp.json"], restored: false };
		const el = loadNoticeRenderer()(notice);
		document.body.appendChild(el);
		(el.querySelector(".delete-notice-undo") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(el.classList.contains("restored")).toBe(true));
		expect(posted[0]).toMatchObject({ paths: ["C:\\w\\ns_tmp.json"] });
		expect(notice.restored).toBe(true);
		expect(g.saveChats).toHaveBeenCalled();
		expect(el.querySelector(".delete-notice-undo")).toBeNull();
	});

	it("a restore that fails says why and keeps Undo available", async () => {
		g.apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ path: "x", error: "The trashed copy is gone." }] }) }));
		g.saveChats = vi.fn();
		const notice: Notice = { id: "dn-r2", files: ["x"], restored: false };
		const el = loadNoticeRenderer()(notice);
		(el.querySelector(".delete-notice-undo") as HTMLButtonElement).click();
		await vi.waitFor(() => expect(el.textContent).toContain("The trashed copy is gone."));
		expect(notice.restored).toBe(false);
		expect(el.querySelector(".delete-notice-undo")).not.toBeNull();
	});
});

describe("the notice rides the stream store onto the saved row", () => {
	it("delete_notice lands on the turn once, and finalize keeps the same objects on the message", () => {
		for (const f of ["chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
			new Function(src(f))();
		}
		const store = (g.window as { ChatStreamStore: Record<string, (...a: unknown[]) => unknown> }).ChatStreamStore;
		const sid = "sess-notice";
		store.startTurn(sid, 0);
		store.applyEvent(sid, { type: "stream", delta: "Cleaned up." });
		const ev = { type: "delete_notice", files: ["C:\\w\\ns_tmp.json"], toolCallIds: ["r1"] };
		store.applyEvent(sid, ev);
		store.applyEvent(sid, ev);
		const entry = store.get(sid) as { notices: Notice[] };
		expect(entry.notices).toHaveLength(1);
		expect(entry.notices[0]).toMatchObject({ id: "dn-r1", files: ["C:\\w\\ns_tmp.json"], restored: false });

		const live = entry.notices[0];
		store.applyEvent(sid, { type: "done" });
		const msg = store.promoteLiveToMessages(sid, { messages: [] }) as { _notices: Notice[] };
		expect(msg._notices).toHaveLength(1);
		// The same object: an Undo clicked on the live bubble is what the saved row shows.
		expect(msg._notices[0]).toBe(live);
		expect((store.get(sid) as { notices: Notice[] }).notices).toHaveLength(0);
	});
});

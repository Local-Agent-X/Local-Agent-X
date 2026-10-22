// @vitest-environment happy-dom
//
// A long turn's thinking is split into one stretch per tool run (the tool runs
// themselves draw in the activity group), so the bubble stacked a "▸ Thinking"
// line per step. Stretches with nothing shown between them now fold into ONE
// row, "Thinking · N steps"; answer text and mid-turn messages still split it.
// Drives the real renderTimelineBlocks (chat-render-artifacts.js).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;
type Block = { id: string; type: string; text?: string };
let render: (body: HTMLElement, blocks: Block[], opts?: { live?: boolean }) => boolean;

beforeAll(() => {
	g.md = (s: string) => `<p>${s}</p>`;
	g.esc = (s: string) => String(s).replace(/</g, "&lt;");
	g.mdPreviewMode = true;
	const src = readFileSync(join(here, "../public/js/chat-render-artifacts.js"), "utf8");
	render = (new Function(`${src}; return renderTimelineBlocks;`)() as typeof render);
});

const think = (id: string, text: string): Block => ({ id, type: "reasoning", text });
const text = (id: string, t: string): Block => ({ id, type: "text", text: t });

function draw(blocks: Block[], live = false): HTMLElement {
	const body = document.createElement("div");
	render(body, blocks, { live });
	return body;
}

describe("thinking stretches fold into one row", () => {
	it("back-to-back stretches are one 'Thinking · N steps' row, each stretch kept in order", () => {
		const body = draw([think("b1", "check git"), think("b2", "read the file"), think("b3", "run tests")]);
		const rows = body.querySelectorAll(".reasoning-block");
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector(".reasoning-summary")?.textContent).toBe("Thinking · 3 steps");
		expect([...rows[0].querySelectorAll(".reasoning-step")].map((s) => s.textContent)).toEqual(["check git", "read the file", "run tests"]);
	});

	it("answer text splits the runs, and a lone stretch reads as before", () => {
		const body = draw([think("b1", "a"), think("b2", "b"), text("b3", "Here is the plan."), think("b4", "c")]);
		const rows = [...body.querySelectorAll(".reasoning-block")];
		expect(rows.map((r) => r.querySelector(".reasoning-summary")?.textContent)).toEqual(["Thinking · 2 steps", "Thinking"]);
		expect(body.children[1].className).toBe("block-text");
	});

	it("an empty text block between stretches does not split them", () => {
		const body = draw([think("b1", "a"), text("b2", "   "), think("b3", "b")]);
		expect(body.querySelectorAll(".reasoning-block")).toHaveLength(1);
	});

	it("while live, the trailing run is open and keyed by its first stretch; a finished run is closed", () => {
		const body = draw([think("b1", "a"), text("b2", "so far"), think("b3", "b"), think("b4", "c")], true);
		const rows = [...body.querySelectorAll("details.reasoning-block")] as HTMLDetailsElement[];
		expect(rows.map((r) => r.open)).toEqual([false, true]);
		expect(rows[1].dataset.key).toBe("r:b3");
	});

	it("thinking text is never parsed as markup", () => {
		const body = draw([think("b1", "<img src=x onerror=alert(1)>"), think("b2", "ok")]);
		expect(body.querySelector("img")).toBeNull();
	});
});

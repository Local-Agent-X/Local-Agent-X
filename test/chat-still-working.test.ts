// @vitest-environment happy-dom
//
// A model may write a question and keep working past it (the parts that need
// no answer). The text reads as the finished reply while only the stop button
// says otherwise, and an approval card that arrives under it can expire
// unseen. So: once the text has stopped arriving and the turn goes on, a
// caption sits right under the last text; it is gone from the finished row.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;
const load = <T>(file: string, ret: string): T => {
	const src = readFileSync(join(here, "../public/js/" + file), "utf8");
	return new Function(`${src}; return ${ret};`)() as T;
};

type Store = { content: string; blocks: Array<{ type: string; text: string; id: string }>; lastContentMs?: number; toolEvents: unknown[] };
type Artifacts = { _buildLiveAssistantInto: (parent: HTMLElement, store: Store) => HTMLElement };
let artifacts: Artifacts;

beforeEach(() => {
	document.body.innerHTML = "";
	g.esc = (s: unknown) => String(s ?? "");
	g.md = (s: string) => `<p>${s}</p>`;
	g.mdPreviewMode = true;
	g.thinkingHTML = () => '<div class="thinking">…</div>';
	Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
	Object.assign(g, load<object>("chat-declassify-action.js", "{ isKernelBlockNotice, renderKernelBlockNotice }"));
	Object.assign(g, load<object>("chat-file-changes.js", "{ fileChangesOf, renderFileChangesCard }"));
	artifacts = load<Artifacts>("chat-render-artifacts.js", "{ _buildLiveAssistantInto }");
});

const question = { type: "text", text: "Ready to start the database tables?", id: "t1" };

describe("the live bubble while the model works past its own text", () => {
	it("captions the text as not final once it has stopped arriving and the turn goes on", () => {
		const row = artifacts._buildLiveAssistantInto(document.body, {
			content: question.text, blocks: [question], lastContentMs: Date.now() - 60_000, toolEvents: [],
		});
		const text = row.querySelector(".block-text") as HTMLElement;
		const next = text.nextElementSibling as HTMLElement;
		expect(next.className).toBe("still-working");
		expect(next.textContent).toContain("final answer yet");
	});

	it("shows no caption while the text is still arriving", () => {
		const row = artifacts._buildLiveAssistantInto(document.body, {
			content: question.text, blocks: [question], lastContentMs: Date.now(), toolEvents: [],
		});
		expect(row.querySelector(".still-working")).toBeNull();
	});

	it("the finished row carries no caption", () => {
		// The finalize path builds the terminal paint from a store with no
		// content clock, which _buildLiveAssistantInto never treats as idle.
		const row = artifacts._buildLiveAssistantInto(document.body, { content: question.text, blocks: [question], toolEvents: [] });
		expect(row.querySelector(".still-working")).toBeNull();
	});
});

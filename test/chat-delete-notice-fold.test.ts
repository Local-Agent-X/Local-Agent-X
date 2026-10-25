// @vitest-environment happy-dom
//
// A delete notice names a file this request created and then removed — the
// agent's own scratch. That is a line of agent activity with an Undo, so it
// renders inside the activity group, not as a strip under the answer; only a
// turn that ran no other tool shows it on the row itself.
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

type Notice = { id: string; files: string[]; restored: boolean };
type ToolEvent = { type: "start" | "end"; name: string; toolCallId: string; args?: Record<string, string>; status?: string; result?: string };
type Artifacts = { _renderAssistantToolArtifacts: (body: HTMLElement, data: { toolEvents: ToolEvent[]; notices: Notice[] }) => void };
let artifacts: Artifacts;

beforeEach(() => {
	document.body.innerHTML = "";
	g.esc = (s: unknown) => String(s ?? "");
	console.error = (...a: unknown[]) => { throw new Error("render error: " + a.map(String).join(" ")); };
	Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
	Object.assign(g, load<object>("chat-declassify-action.js", "{ isKernelBlockNotice, renderKernelBlockNotice }"));
	Object.assign(g, load<object>("chat-file-changes.js", "{ fileChangesOf, renderFileChangesCard }"));
	Object.assign(g, load<object>("chat-render-notices.js", "{ renderDeleteNotice, renderLearningNotice, renderReviewNotice }"));
	artifacts = load<Artifacts>("chat-render-artifacts.js", "{ _renderAssistantToolArtifacts }");
});

const notice: Notice = { id: "dn-d1", files: ["C:\\w\\shared\\src\\.probe-check.mjs"], restored: false };
const deleteCall: ToolEvent[] = [
	{ type: "start", name: "delete_file", toolCallId: "d1", args: { path: ".probe-check.mjs" } },
	{ type: "end", name: "delete_file", toolCallId: "d1", status: "ok", result: "moved to task trash" },
];

describe("a delete of the agent's own scratch file", () => {
	it("is a line inside the activity group, with its Undo, not a strip on the row", () => {
		const body = document.createElement("div");
		artifacts._renderAssistantToolArtifacts(body, { toolEvents: deleteCall, notices: [notice] });
		const inGroup = body.querySelector(".activity-group .activity-group-body .delete-notice") as HTMLElement;
		expect(inGroup).not.toBeNull();
		expect(inGroup.classList.contains("in-activity")).toBe(true);
		expect(inGroup.textContent).toContain(".probe-check.mjs");
		expect(inGroup.querySelector(".delete-notice-undo")).not.toBeNull();
		// Nothing of it outside the group.
		expect(body.querySelectorAll(":scope > .delete-notice")).toHaveLength(0);
	});

	it("stays on the row only when the turn ran no other tool (no group to join)", () => {
		const body = document.createElement("div");
		artifacts._renderAssistantToolArtifacts(body, { toolEvents: [], notices: [notice] });
		expect(body.querySelector(".activity-group")).toBeNull();
		expect(body.querySelectorAll(":scope > .delete-notice")).toHaveLength(1);
	});
});

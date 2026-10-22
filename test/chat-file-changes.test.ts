// @vitest-environment happy-dom
//
// A reply that wrote files shows an "Edited N files" card (one row per file,
// lines added and removed), and opening it draws the diff in the CHANGES tab:
// unchanged stretches between hunks fold to a count, line numbers follow each
// side, and file text is rendered as text, never HTML. Drives the real client
// source with the same `new Function` harness as the other card tests.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../public/js/" + f), "utf8");

interface FileChanges {
  fileChangesOf(events: unknown[]): Array<{ path: string; added: number; removed: number; edits: unknown[] }>;
  renderFileChangesCard(files: unknown[]): HTMLElement;
}

let m: FileChanges;
let switchedTo: string | null;

const end = (fileChange: Record<string, unknown>) => ({ type: "end", name: "edit", status: "ok", metadata: { fileChange } });

const EDIT_1 = {
  path: "/repo/src/a.ts", created: false, added: 1, removed: 1,
  hunks: [{ oldStart: 10, newStart: 10, lines: [" keep", "-<b>old</b>", "+new", " tail"] }],
};
const EDIT_2 = {
  path: "/repo/src/a.ts", created: false, added: 2, removed: 0,
  hunks: [{ oldStart: 40, newStart: 40, lines: [" x", "+y", "+z"] }],
};
const CREATED = { path: "/repo/docs/b.md", created: true, added: 3, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ["+1", "+2", "+3"] }] };

beforeEach(() => {
  document.body.innerHTML = '<button id="side-tab-changes" style="display:none"></button><div id="changes-tab-body"></div>';
  const g = globalThis as unknown as Record<string, unknown>;
  g.esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  switchedTo = null;
  g.agentFeedsOpen = true;
  m = new Function(
    "switchSidePanelTab",
    src("chat-file-changes.js") + "\nreturn { fileChangesOf, renderFileChangesCard, renderFileChangesTab };",
  )((tab: string) => {
    switchedTo = tab;
    (m as unknown as { renderFileChangesTab(): void }).renderFileChangesTab();
  }) as FileChanges;
});

describe("the files a reply changed", () => {
  it("groups a turn's writes by file, in the order first touched, summing their counts", () => {
    const files = m.fileChangesOf([
      { type: "start", name: "edit" },
      end(EDIT_1),
      { type: "end", name: "bash", status: "ok", metadata: { exit_code: 0 } },
      end(CREATED),
      end(EDIT_2),
    ]);
    expect(files.map((f) => [f.path, f.added, f.removed, f.edits.length])).toEqual([
      ["/repo/src/a.ts", 3, 1, 2],
      ["/repo/docs/b.md", 3, 0, 1],
    ]);
  });

  it("the card names each file with its counts", () => {
    const card = m.renderFileChangesCard(m.fileChangesOf([end(EDIT_1), end(CREATED)]));
    expect(card.querySelector(".file-changes-head")!.textContent).toContain("Edited 2 files");
    const rows = [...card.querySelectorAll(".file-change-row")].map((r) => r.textContent);
    expect(rows).toEqual(["a.ts/repo/src+1 -1", "b.md/repo/docs+3 -0"]);
  });

  it("opening a row shows the CHANGES tab with the diff, gaps folded and text kept as text", () => {
    const card = m.renderFileChangesCard(m.fileChangesOf([end(EDIT_1), end(EDIT_2)]));
    (card.querySelector(".file-change-row") as HTMLElement).click();
    expect(switchedTo).toBe("changes");
    expect((document.getElementById("side-tab-changes") as HTMLElement).style.display).toBe("");
    const body = document.getElementById("changes-tab-body")!;
    const gaps = [...body.querySelectorAll(".diff-gap")].map((g) => g.textContent);
    expect(gaps).toEqual(["⋯ 9 unmodified lines", "⋯ 39 unmodified lines"]);
    expect([...body.querySelectorAll(".diff-edit-sep")].map((s) => s.textContent)).toEqual(["Edit 1 of 2", "Edit 2 of 2"]);
    const del = body.querySelector(".diff-line.del")!;
    expect(del.querySelector(".diff-code")!.textContent).toBe("<b>old</b>");
    expect(del.querySelector("b")).toBeNull();
    const cells = (row: Element) => [...row.querySelectorAll(".diff-ln")].map((c) => c.textContent);
    const rows = [...body.querySelectorAll(".diff-line")];
    expect(cells(rows[0]!)).toEqual(["10", "10"]); // context
    expect(cells(rows[1]!)).toEqual(["11", ""]); // removed
    expect(cells(rows[2]!)).toEqual(["", "11"]); // added
    expect(cells(rows[3]!)).toEqual(["12", "12"]);
  });

  it("a change with no hunks says why instead of drawing nothing", () => {
    const card = m.renderFileChangesCard(m.fileChangesOf([end({ path: "/repo/.env", created: false, added: 1, removed: 1 })]));
    (card.querySelector(".file-changes-all") as HTMLElement).click();
    expect(document.querySelector(".diff-note")!.textContent).toContain("not shown");
  });
});

// @vitest-environment happy-dom
//
// The side panel's Overview (side-overview.js): what the chat on screen is
// doing, its project's plan and spec to read, its context and background
// work. A build wrote its spec and plan and the owner had no way to read them
// but to ask (2026-11-25). Pure producers, loaded via a Function factory like
// the chat-agent-feeds-*.test.ts files.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Rec = Record<string, unknown>;
type Work = { now: { title: string; on: string; elapsed: string; tokens: number } | null; background: { id: string; title: string }[] };
let api: {
  overviewWork: (feeds: Record<string, Rec>, now: number) => Work;
  overviewSortDocs: (docs: { path: string }[]) => { path: string }[];
  overviewHtml: (view: { work?: Work; docs?: { path: string }[]; context?: Rec | null }) => string;
  overviewDocHtml: (doc: { path: string; text: string | null }) => string;
};

beforeAll(() => {
  const src =
    readFileSync(join(here, "../public/js/shared-escape.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-ambient.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-jobs.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/side-overview.js"), "utf8");
  // eslint-disable-next-line no-new-func
  api = new Function("md", src + "\nreturn { overviewWork, overviewSortDocs, overviewHtml, overviewDocHtml };")((t: string) => `<p>${t}</p>`);
});

const NOW = 1_700_000_000_000;
const toEl = (html: string) => { const h = document.createElement("div"); h.innerHTML = html; return h; };

describe("overviewWork", () => {
  it("is the live root job, the worker it is on and their tokens; every live record is background", () => {
    const feeds: Record<string, Rec> = {
      orch: { id: "orch", name: "Worker: Build label-check-sol (chunks 1-5)", status: "working", startedAt: NOW - 120_000, totalTokens: 1000 },
      w1: { id: "w1", name: "Chunk 4/5: Native scan", status: "completed", parentOpId: "orch", startedAt: NOW - 100_000, totalTokens: 500 },
      w2: { id: "w2", name: "Finish fix 1: hostile findings (1 of 4)", status: "working", parentOpId: "orch", startedAt: NOW - 30_000, totalTokens: 2000 },
    };
    const w = api.overviewWork(feeds, NOW);
    expect(w.now).toMatchObject({ title: "Build label-check-sol (chunks 1-5)", on: "Finish fix 1: hostile findings (1 of 4)", tokens: 3500 });
    expect(w.background.map((b) => b.id)).toEqual(["orch", "w2"]);
  });

  it("is nothing when nothing runs", () => {
    expect(api.overviewWork({ done: { id: "done", status: "completed" } }, NOW)).toEqual({ now: null, background: [] });
  });
});

describe("overviewHtml", () => {
  it("lists the plan first, then the spec, and says when there is none", () => {
    const sorted = api.overviewSortDocs([{ path: "README.md" }, { path: "spec/ledger.md" }, { path: "spec/plan.md" }, { path: "twins/ai.md" }, { path: "spec/product.md" }]);
    expect(sorted.map((d) => d.path)).toEqual(["spec/plan.md", "spec/product.md", "spec/ledger.md", "README.md", "twins/ai.md"]);
    const el = toEl(api.overviewHtml({ docs: sorted }));
    expect([...el.querySelectorAll("[data-overview-doc]")].map((b) => b.getAttribute("data-overview-doc"))[0]).toBe("spec/plan.md");
    expect(toEl(api.overviewHtml({ docs: [] })).textContent).toContain("No plan or spec in this chat's project yet");
  });

  it("shows what is running, the context used, and nothing made up when unmeasured", () => {
    const work = { now: { title: "Build label-check-sol", on: "Finish fix 1: hostile findings (1 of 4)", elapsed: "31m", tokens: 0 }, background: [{ id: "orch", title: "Build label-check-sol" }] };
    const el = toEl(api.overviewHtml({ work, context: { percentage: 8, usedTokens: 73_000, maxTokens: 921_000 } }));
    expect(el.querySelector(".overview-now-title")!.textContent).toBe("Build label-check-sol");
    expect(el.textContent).toContain("8% used");
    expect(el.querySelector("[data-overview-job]")!.getAttribute("data-overview-job")).toBe("orch");
    expect(toEl(api.overviewHtml({})).textContent).toContain("Not measured yet");
    expect(toEl(api.overviewHtml({})).textContent).toContain("Nothing running in this chat");
  });

  it("renders a document as markdown with a way back, and escapes its path", () => {
    const el = toEl(api.overviewDocHtml({ path: "spec/<b>plan</b>.md", text: "## Chunk 1" }));
    expect(el.querySelector("[data-overview-back]")).not.toBeNull();
    expect(el.querySelector(".overview-doc-body")!.innerHTML).toBe("<p>## Chunk 1</p>");
    expect(el.querySelector(".overview-doc-path")!.innerHTML).not.toContain("<b>");
    expect(toEl(api.overviewDocHtml({ path: "spec/plan.md", text: null })).textContent).toContain("Could not read this document");
  });
});

// @vitest-environment happy-dom
//
// A long reply must read top to bottom in time order (chat-turn-flow.js). On
// 2026-11-23 a 110-call build turn drew all of its narration first, then one
// "Agent activity" box of every call, then a file list twice, the step list in
// the middle and a red review card after an "Approved" row; a 9-minute silent
// call showed nothing at the bottom, and the owner asked twice whether the
// agent was stuck. These drive the real entry points with the real browser
// scripts, loaded as app.html loads them.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;

type Ev = Record<string, unknown>;
type Block = { id: string; type: string; text?: string };
type Data = { toolEvents: Ev[]; blocks?: Block[] | null; notices?: Ev[]; approvals?: Ev[]; stopNote?: Ev };
type Artifacts = {
  renderTimelineBlocks: (body: HTMLElement, blocks: Block[], opts?: { live?: boolean }) => boolean;
  _renderAssistantToolArtifacts: (body: HTMLElement, data: Data) => void;
  _buildLiveAssistantInto: (parent: HTMLElement, store: Ev) => HTMLElement;
};

let A: Artifacts;
let formatElapsed: (ms: number) => string;

const load = <T>(file: string, ret: string): T => {
  const src = readFileSync(join(here, "../public/js/" + file), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${ret};`)() as T;
};

beforeEach(() => {
  document.body.innerHTML = "";
  g.esc = (s: unknown) => String(s ?? "");
  g.md = (s: string) => `<p>${s}</p>`;
  g.mdPreviewMode = true;
  g.thinkingHTML = () => '<div class="thinking">…</div>';
  console.error = (...a: unknown[]) => { throw new Error("render error: " + a.map(String).join(" ")); };
  Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
  Object.assign(g, load<object>("chat-declassify-action.js", "{ isKernelBlockNotice, renderKernelBlockNotice }"));
  Object.assign(g, load<object>("chat-file-changes.js", "{ fileChangesOf, renderFileChangesCard, changesNoticeCovers }"));
  Object.assign(g, load<object>("chat-cards.js", "{ cardsOf, renderChatCards }"));
  Object.assign(g, load<object>("chat-render-notices.js", "{ renderDeleteNotice, renderChangesNotice, renderReviewNotice, renderLearningNotice, renderHandoffNotice }"));
  Object.assign(g, load<object>("chat-progress.js", "{ isProgressTool, renderReplyClose }"));
  const flow = load<{ formatElapsed: (ms: number) => string }>("chat-turn-flow.js", "{ isSegmentBreak, toolSegmentsOf, renderTurnNow, formatElapsed }");
  Object.assign(g, flow);
  formatElapsed = flow.formatElapsed;
  A = load<Artifacts>("chat-render-artifacts.js", "{ renderTimelineBlocks, _renderAssistantToolArtifacts, _buildLiveAssistantInto }");
});

const text = (id: string, t: string): Block => ({ id, type: "text", text: t });
const think = (id: string, t: string): Block => ({ id, type: "reasoning", text: t });
const start = (id: string, name: string, afterBlock: string | null | undefined, extra: Ev = {}): Ev =>
  ({ type: "start", name, toolCallId: id, args: { command: id }, ...(afterBlock === undefined ? {} : { afterBlock }), ...extra });
const end = (id: string, name: string, status = "ok", extra: Ev = {}): Ev =>
  ({ type: "end", name, toolCallId: id, status, result: "", ...extra });

/** A finished row exactly as renderMessage draws it: timeline, then artifacts. */
function row(blocks: Block[], data: Data): HTMLElement {
  const body = document.createElement("div");
  A.renderTimelineBlocks(body, blocks, { live: false });
  A._renderAssistantToolArtifacts(body, { blocks, ...data });
  return body;
}

/** The row's visible pieces, in order, as short labels. */
function outline(body: HTMLElement): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const c of [...el.children]) {
      if (c.classList.contains("tool-segment")) { walk(c); continue; }
      if (c.classList.contains("block-text")) out.push("text:" + c.textContent);
      else if (c.classList.contains("activity-group")) out.push("tools:" + c.querySelectorAll(".tool-card").length);
      else if (c.classList.contains("reasoning-block")) out.push("thinking");
      else out.push(c.className.split(" ")[0]);
    }
  };
  walk(body);
  return out;
}

describe("tool calls sit between the text they ran between", () => {
  it("each stretch of calls is its own group, at the point it ran", () => {
    const blocks = [text("t1", "Looking at the build."), think("r1", "check it"), text("t2", "Found it; fixing."), text("t3", "Done.")];
    const body = row(blocks, {
      toolEvents: [
        start("a", "bash", "t1"), end("a", "bash"),
        start("b", "read", "r1"), end("b", "read"),
        start("c", "edit", "t2"), end("c", "edit", "error"),
      ],
    });
    expect(outline(body)).toEqual(["text:Looking at the build.", "thinking", "tools:2", "text:Found it; fixing.", "tools:1", "text:Done."]);
    // Each group counts its own calls: the failure belongs to the second.
    const labels = [...body.querySelectorAll(".activity-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Agent activity", "Agent activity · 1 failed"]);
  });

  it("only the newest group of a running turn spins; earlier ones are done", () => {
    const blocks = [text("t1", "Step one."), text("t2", "Step two.")];
    const body = row(blocks, { toolEvents: [start("a", "bash", "t1"), end("a", "bash"), start("b", "holdout_judge", "t2")] });
    const ticks = [...body.querySelectorAll(".activity-tick")].map((t) => t.textContent);
    expect(ticks).toEqual(["✓", "⚙"]);
  });

  it("a call saved before the stamp existed, or replayed, goes last, as before", () => {
    const blocks = [text("t1", "One."), text("t2", "Two.")];
    const body = row(blocks, { toolEvents: [start("a", "bash", undefined), end("a", "bash")] });
    expect(outline(body)).toEqual(["text:One.", "text:Two.", "tools:1"]);
  });

  it("a call before any text goes first", () => {
    const body = row([text("t1", "Here is what I found.")], { toolEvents: [start("a", "grep", null), end("a", "grep")] });
    expect(outline(body)).toEqual(["tools:1", "text:Here is what I found."]);
  });

  it("a row with no block timeline keeps one group after the text", () => {
    const body = document.createElement("div");
    A._renderAssistantToolArtifacts(body, { toolEvents: [start("a", "bash", "t9"), end("a", "bash")], blocks: null });
    expect(outline(body)).toEqual(["tools:1"]);
  });
});

describe("the end of the reply", () => {
  it("the step list comes after approvals and notices, under everything the turn did", () => {
    const plan = [{ text: "Build it", status: "completed" }, { text: "Ship it", status: "in_progress" }];
    const body = row([text("t1", "Working.")], {
      toolEvents: [start("p", "update_plan", "t1"), end("p", "update_plan", "ok", { metadata: { plan } }), start("a", "bash", "t1"), end("a", "bash")],
      notices: [{ kind: "review", id: "r", status: "RED", summary: "1 commit", findings: [{ severity: "red", location: "a.ts:1", problem: "p" }] }],
    });
    const parts = outline(body);
    expect(parts.indexOf("chat-plan")).toBe(parts.length - 1);
    expect(parts.indexOf("review-notice")).toBeLessThan(parts.indexOf("chat-plan"));
  });

  it("a review shown after a publish ran reads as a record, not a block", () => {
    const body = row([text("t1", "Deployed.")], {
      toolEvents: [start("a", "bash", "t1"), end("a", "bash")],
      notices: [{ kind: "review", id: "r", status: "RED", summary: "62 commits", findings: [{ severity: "red", location: "x:1", problem: "p" }] }],
    });
    const notice = body.querySelector(".review-notice") as HTMLElement;
    expect(notice.textContent).toContain("Published. Its pre-publish review rated it RED with 1 finding in 62 commits");
  });
});

describe("the changed files are listed once", () => {
  const fileEnd = (id: string, path: string): Ev => end(id, "edit", "ok", { metadata: { fileChange: { path, added: 2, removed: 1 } } });

  it("a changes notice naming the same files becomes the card's Undo", () => {
    const body = row([text("t1", "Edited.")], {
      toolEvents: [start("a", "edit", "t1"), fileEnd("a", "C:\\work\\app\\src\\a.ts"), start("b", "edit", "t1"), fileEnd("b", "C:\\work\\app\\src\\b.ts")],
      notices: [{ kind: "changes", id: "n", files: ["src/a.ts", "src/b.ts"], sessionId: "s", opId: "o" }],
    });
    expect(body.querySelectorAll(".file-changes")).toHaveLength(1);
    expect(body.querySelectorAll(":scope > .changes-notice")).toHaveLength(0);
    expect(body.querySelector(".file-changes-head .changes-notice.in-file-card .delete-notice-undo")).toBeTruthy();
  });

  it("a notice naming a file the card does not list stays on its own", () => {
    const body = row([text("t1", "Edited.")], {
      toolEvents: [start("a", "edit", "t1"), fileEnd("a", "src/a.ts")],
      notices: [{ kind: "changes", id: "n", files: ["src/a.ts", "scripts/gen.mjs"], sessionId: "s", opId: "o" }],
    });
    expect(body.querySelector(".file-changes .changes-notice")).toBeNull();
    expect(body.querySelectorAll(":scope > .changes-notice")).toHaveLength(1);
  });
});

describe("a running reply says what it is doing now", () => {
  const store = (toolEvents: Ev[]): Ev => ({
    content: "Scoring the app.", blocks: [text("t1", "Scoring the app.")], toolEvents, reasoning: "",
    chips: [], progressByTool: {}, approvals: [], notices: [], lastContentMs: Date.now(),
  });

  it("the call in flight and how long it has run, as the bubble's last line", () => {
    const startedMs = Date.now() - (6 * 60 + 12) * 1000;
    const bubble = A._buildLiveAssistantInto(document.body, store([start("j", "holdout_judge", "t1", { startedMs })]));
    const body = bubble.querySelector(".msg-body") as HTMLElement;
    const now = body.lastElementChild as HTMLElement;
    expect(now.className).toBe("turn-now");
    // A tool with no phrase of its own is named, never shown as raw arguments.
    expect(now.querySelector(".turn-now-what")!.textContent).toBe("Running holdout_judge");
    expect(now.querySelector(".turn-now-elapsed")!.textContent).toBe("6m 12s");
  });

  it("a tool with its own phrase says it in its own words", () => {
    const bubble = A._buildLiveAssistantInto(document.body, store([start("b", "bash", "t1", { startedMs: Date.now(), args: { command: "npm test" } })]));
    expect(bubble.querySelector(".turn-now-what")!.textContent).toBe("Running: npm test");
  });

  it("no line once every call has ended", () => {
    const bubble = A._buildLiveAssistantInto(document.body, store([start("j", "bash", "t1", { startedMs: Date.now() }), end("j", "bash")]));
    expect(bubble.querySelector(".turn-now")).toBeNull();
  });

  it("a second call of the same tool still running is not handed the first one's end", () => {
    const bubble = A._buildLiveAssistantInto(document.body, store([
      start("a", "bash", "t1", { startedMs: Date.now() }), end("a", "bash"), start("b", "bash", "t1", { startedMs: Date.now() }),
    ]));
    expect(bubble.querySelector(".turn-now")).toBeTruthy();
    expect(bubble.querySelector(".activity-tick")!.textContent).toBe("⚙");
  });

  it("formats elapsed time for seconds, minutes and hours", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(372_000)).toBe("6m 12s");
    expect(formatElapsed(3_900_000)).toBe("1h 5m");
  });
});

describe("repeated thinking folds behind the newest step", () => {
  it("earlier steps sit in one folded row; the newest shows", () => {
    const body = document.createElement("div");
    A.renderTimelineBlocks(body, [think("r1", "port 7070 held"), think("r2", "port 7070 still held"), think("r3", "re-running the judge")], { live: true });
    const earlier = body.querySelector(".reasoning-earlier") as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector("summary")!.textContent).toBe("2 earlier steps");
    const steps = body.querySelectorAll(".reasoning-body > .reasoning-step");
    expect(steps).toHaveLength(1);
    expect(steps[0].textContent).toBe("re-running the judge");
  });
});

describe("the reducer stamps each call", () => {
  it("with the block it came after and when it started", () => {
    for (const f of ["agentxos-timeline.js", "chat-stream-blocks.js", "chat-stream-reducer.js", "chat-stream-admit.js", "chat-stream-store.js", "chat-stream-finalize.js"]) {
      // eslint-disable-next-line no-new-func
      new Function(readFileSync(join(here, "../public/js/" + f), "utf8"))();
    }
    type Store = { startTurn(s: string): unknown; applyEvent(s: string, e: Ev): void; get(s: string): { toolEvents: Ev[]; blocks: Block[] } };
    const S = (globalThis as unknown as { window: { ChatStreamStore: Store } }).window.ChatStreamStore;
    S.startTurn("s1");
    S.applyEvent("s1", { type: "tool_start", toolName: "grep", toolCallId: "x0", args: {} });
    S.applyEvent("s1", { type: "stream", delta: "Looking." });
    S.applyEvent("s1", { type: "tool_start", toolName: "bash", toolCallId: "x1", args: {}, startedAt: 1_000 });
    const e = S.get("s1");
    const [first, second] = e.toolEvents;
    expect(first.afterBlock).toBeNull();
    expect(second.afterBlock).toBe(e.blocks[e.blocks.length - 1].id);
    expect(second.startedMs).toBe(1_000);
    expect(typeof first.startedMs).toBe("number");
  });
});

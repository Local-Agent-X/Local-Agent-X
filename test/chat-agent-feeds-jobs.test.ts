// @vitest-environment happy-dom
//
// The background-tasks layout (chat-agent-feeds-jobs.js): one list of
// running jobs (a root op with its workers as phase tables), single tasks,
// and a Finished drawer. Pure producers, loaded via a Function factory like
// the sibling chat-agent-feeds-*.test.ts files.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Agent = Record<string, unknown>;
type ViewState = { expanded?: Record<string, unknown>; phaseOpen?: Record<string, boolean>; finishedOpen?: boolean };
let api: {
  jobElapsedLabel: (start: unknown, end: unknown, now: number) => string;
  jobOutcome: (status: unknown) => { label: string; cls: string };
  jobStallMs: (rec: Agent, now: number) => number;
  jobPhases: (node: unknown, map: Record<string, Agent>) => { title: string; ids: string[] }[];
  jobIsFinished: (node: unknown, map: Record<string, Agent>) => boolean;
  buildAgentFeedTree: (map: Record<string, Agent>) => unknown[];
  renderBackgroundTasks: (map: Record<string, Agent>, state: ViewState, now: number) => string;
  JOB_STALL_MS: number;
};

beforeAll(() => {
  const src =
    readFileSync(join(here, "../public/js/shared-escape.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-ambient.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-jobs.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { jobElapsedLabel, jobOutcome, jobStallMs, jobPhases, jobIsFinished, buildAgentFeedTree, renderBackgroundTasks, JOB_STALL_MS };");
  api = factory();
});

const NOW = 1_700_000_000_000;
const toEl = (html: string) => { const h = document.createElement("div"); h.innerHTML = html; return h; };
const worker = (id: string, extra: Agent = {}): Agent => ({
  id, name: "Worker: " + id, type: "agent", status: "working", output: "", parentOpId: "root",
  startedAt: NOW - 90_000, lastActivityMs: NOW, totalTokens: 1500, model: "opus-5.5", ...extra,
});
const root = (extra: Agent = {}): Agent => ({
  id: "root", name: "Build the CRM", type: "orchestrator", status: "working", currentTask: "Build the CRM\nwith three pages",
  output: "", startedAt: NOW - 120_000, lastActivityMs: NOW, totalTokens: 20_000, ...extra,
});

describe("jobElapsedLabel", () => {
  it("counts from the start to now, or to the end once there is one", () => {
    expect(api.jobElapsedLabel(NOW - 42_000, 0, NOW)).toBe("42s");
    expect(api.jobElapsedLabel(NOW - 125_000, 0, NOW)).toBe("2m 05s");
    expect(api.jobElapsedLabel(NOW - 3_720_000, 0, NOW)).toBe("1h 02m");
    expect(api.jobElapsedLabel(NOW - 125_000, NOW - 65_000, NOW)).toBe("1m 00s");
  });
  it("is blank with no start, and never negative", () => {
    expect(api.jobElapsedLabel(undefined, 0, NOW)).toBe("");
    expect(api.jobElapsedLabel(NOW + 5000, 0, NOW)).toBe("0s");
  });
});

describe("jobOutcome", () => {
  it("names each outcome and keeps queued and paused apart from running", () => {
    expect(api.jobOutcome("queued #3").label).toBe("Queued");
    expect(api.jobOutcome("working").label).toBe("Running");
    expect(api.jobOutcome("blocked")).toEqual({ label: "blocked", cls: "paused" });
    expect(api.jobOutcome("failed").cls).toBe("failed");
  });
});

describe("jobStallMs", () => {
  it("flags a live op silent past the threshold, never a queued or finished one", () => {
    expect(api.jobStallMs(worker("a"), NOW)).toBe(0);
    expect(api.jobStallMs(worker("a", { lastActivityMs: NOW - api.JOB_STALL_MS }), NOW)).toBe(api.JOB_STALL_MS);
    expect(api.jobStallMs(worker("a", { status: "queued #1", lastActivityMs: NOW - 999_999 }), NOW)).toBe(0);
    expect(api.jobStallMs(worker("a", { status: "completed", lastActivityMs: NOW - 999_999 }), NOW)).toBe(0);
  });
});

describe("jobPhases / jobIsFinished", () => {
  it("groups a job's workers by their phase name, in first-seen order, excluding the root", () => {
    const map = {
      root: root(),
      a: worker("a", { phase: "Implement" }), b: worker("b", { phase: "Review" }), c: worker("c", { phase: "Implement" }),
    };
    const phases = api.jobPhases(api.buildAgentFeedTree(map)[0], map);
    expect(phases.map((p) => p.title)).toEqual(["Implement", "Review"]);
    expect(phases[0].ids).toEqual(["a", "c"]);
  });
  it("a job is finished only when the root and every worker are terminal", () => {
    const live = { root: root(), a: worker("a", { status: "completed" }) };
    expect(api.jobIsFinished(api.buildAgentFeedTree(live)[0], live)).toBe(false);
    const done = { root: root({ status: "completed" }), a: worker("a", { status: "failed" }) };
    expect(api.jobIsFinished(api.buildAgentFeedTree(done)[0], done)).toBe(true);
  });
});

describe("renderBackgroundTasks", () => {
  it("renders a running job: header roll-up, one row per worker with model, tokens and time", () => {
    const map = { root: root(), a: worker("a"), b: worker("b", { status: "queued #2", startedAt: undefined, totalTokens: 0 }) };
    const el = toEl(api.renderBackgroundTasks(map, {}, NOW));
    const job = el.querySelector(".job")!;
    expect(job.querySelector(".job-head-name")!.textContent).toBe("Build the CRM");
    expect(job.querySelector(".job-head-time")!.textContent).toBe("2m 00s");
    expect(job.querySelector(".job-head-meta")!.textContent).toContain("3 agents");
    expect(job.querySelector(".job-head-meta")!.textContent).toContain("21.5k tokens");
    expect(job.querySelector(".job-head-task")!.textContent).toBe("Build the CRM");
    expect(job.querySelector(".job-phase-count")!.textContent).toBe("0/2");
    const rows = job.querySelectorAll(".job-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".job-row-model")!.textContent).toBe("opus-5.5");
    expect(rows[0].querySelector(".job-row-tokens")!.textContent).toBe("1.5k");
    expect(rows[0].querySelector(".job-row-time")!.textContent).toBe("1m 30s");
    expect(rows[1].className).toContain("queued");
    expect(rows[1].querySelector(".job-row-time")!.textContent).toBe("");
    // The root's detail sits under the head, closed; the Finished drawer is absent.
    expect(el.querySelector("#agent-card-root")).not.toBeNull();
    expect(el.querySelector(".job-finished")).toBeNull();
  });

  it("a phase table is open while a worker is live and folded once all are done, unless the user chose", () => {
    const live = { root: root(), a: worker("a") };
    expect((toEl(api.renderBackgroundTasks(live, {}, NOW)).querySelector(".job-table") as HTMLElement).style.display).toBe("block");
    const done = { root: root(), a: worker("a", { status: "completed" }) };
    expect((toEl(api.renderBackgroundTasks(done, {}, NOW)).querySelector(".job-table") as HTMLElement).style.display).toBe("none");
    expect((toEl(api.renderBackgroundTasks(done, { phaseOpen: { "root/": true } }, NOW)).querySelector(".job-table") as HTMLElement).style.display).toBe("block");
  });

  it("a root with no workers is a single task card", () => {
    const map = { solo: root({ id: "solo", type: "app_build" }) };
    const el = toEl(api.renderBackgroundTasks(map, {}, NOW));
    expect(el.querySelector(".job")).toBeNull();
    const task = el.querySelector(".job-task")!;
    expect(task.querySelector(".job-task-kind")!.textContent).toBe("App build");
    expect(task.querySelector(".job-row-status")!.textContent).toBe("Running");
  });

  it("a task card shows tokens, tool uses and what it is doing, with a transcript that opens on its prompt", () => {
    const map = { solo: root({ id: "solo", type: "app_build", output: "▶ started\n✓ turn 1 · thinking\n✓ turn 2 · read, edit\n✓ turn 3 · bash" }) };
    const el = toEl(api.renderBackgroundTasks(map, { expanded: { solo: 1 } }, NOW));
    const stats = el.querySelector(".job-task-stats")!;
    expect(stats.querySelector(".job-task-tokens")!.textContent).toBe("20.0k tokens");
    expect(stats.querySelector(".job-task-uses")!.textContent).toBe("3 tool uses");
    expect(stats.querySelector(".job-task-activity")!.textContent).toBe("Running bash");
    expect(stats.querySelector(".job-task-transcript")!.textContent).toBe("View transcript");
    expect(el.querySelector('.job-task [data-agent-action="cancel"]')).not.toBeNull();
    const detail = el.querySelector(".job-row-detail") as HTMLElement;
    expect(detail.style.display).toBe("block");
    expect(detail.querySelector(".job-prompt-text")!.textContent).toBe("Build the CRM\nwith three pages");
  });

  it("a stalled op says so on its row", () => {
    const map = { solo: root({ id: "solo", lastActivityMs: NOW - api.JOB_STALL_MS - 60_000 }) };
    const el = toEl(api.renderBackgroundTasks(map, {}, NOW));
    expect(el.querySelector(".job-task")!.className).toContain("stalled");
    expect(el.querySelector(".job-row-stall")!.textContent).toBe("stalled 3m 00s");
    // A worker row shows the stall where its clock was.
    const job = { root: root(), a: worker("a", { lastActivityMs: NOW - api.JOB_STALL_MS - 60_000 }) };
    const rowEl = toEl(api.renderBackgroundTasks(job, {}, NOW)).querySelector(".job-row")!;
    expect(rowEl.className).toContain("stalled");
    expect(rowEl.querySelector(".job-row-time")!.textContent).toBe("stalled 3m");
    expect(el.querySelector('[data-agent-action="cancel"]')).not.toBeNull();
  });

  it("finished work goes to the drawer with its outcome, a count and a clear control", () => {
    const map = {
      ok: root({ id: "ok", status: "completed", endedAt: NOW }),
      bad: root({ id: "bad", status: "failed", endedAt: NOW }),
      live: root({ id: "live" }),
    };
    const el = toEl(api.renderBackgroundTasks(map, { finishedOpen: true }, NOW));
    expect(el.querySelectorAll(":scope > .job-task")).toHaveLength(1);
    expect(el.querySelector(".job-finished-title")!.textContent).toContain("Finished 2");
    expect(el.querySelector('[data-agent-action="clear-finished"]')).not.toBeNull();
    const failed = el.querySelector("#agent-row-bad")!;
    expect(failed.querySelector(".job-row-status")!.className).toContain("failed");
    expect(failed.querySelector(".job-row-status")!.textContent).toBe("Failed");
    expect(failed.querySelector('[data-agent-action="dismiss"]')).not.toBeNull();
  });

  it("says so when there is nothing", () => {
    expect(api.renderBackgroundTasks({}, {}, NOW)).toContain("No background tasks");
  });
});

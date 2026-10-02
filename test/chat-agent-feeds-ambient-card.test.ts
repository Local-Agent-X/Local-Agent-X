// @vitest-environment happy-dom
//
// Ambient ops (dream / cron) in the background-tasks list. Field report
// 2026-07-06: clicking a cron card was a dead end — header only, no path to
// the mission's output or report, and updateAgentFeed's resultUrl write found
// no .agent-feed-result-link to fill. A live ambient op is now a task card in
// the collapsed Ambient group whose detail carries the SAME selectors
// updateAgentFeed targets; a finished one sits in the Finished drawer.
//
// Sources are classic browser globals — loaded via a Function factory like
// the sibling chat-agent-feeds-*.test.ts files.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Agent = Record<string, unknown>;
type ViewState = { expanded?: Record<string, unknown>; ambientOpen?: boolean; finishedOpen?: boolean };
let renderTaskCard: (agent: Agent, now: number, expanded?: boolean) => string;
let renderBackgroundTasks: (map: Record<string, Agent>, state: ViewState, now: number) => string;
let resultLinkHtml: (rawUrl: string) => string;

beforeAll(() => {
  const src =
    readFileSync(join(here, "../public/js/shared-escape.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-ambient.js"), "utf8") + "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-jobs.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { renderTaskCard, renderBackgroundTasks, resultLinkHtml };");
  ({ renderTaskCard, renderBackgroundTasks, resultLinkHtml } = factory());
});

const NOW = 1_700_000_000_000;
const cron: Agent = {
  id: "op-cron-1",
  name: "Worker: <scheduled_task> nightly research",
  type: "scheduled_mission",
  status: "working",
  output: "queued\nstarted\nsearching sources",
  startedAt: NOW - 65_000,
  lastActivityMs: NOW,
};

function toEl(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("renderTaskCard — an ambient op is a task card with a detail (the click dead-end regression)", () => {
  it("carries the detail selectors updateAgentFeed writes to", () => {
    const el = toEl(renderTaskCard(cron, NOW));
    expect(el.querySelector("#agent-card-op-cron-1")).not.toBeNull();
    expect(el.querySelector(".worker-latest")!.textContent).toBe("searching sources");
    expect(el.querySelector(".worker-tools-body")!.textContent).toContain("searching sources");
    expect(el.querySelector(".agent-feed-result-link")).not.toBeNull();
  });

  it("says what it is doing (dreaming / scanning) while live, and its kind once finished", () => {
    expect(toEl(renderTaskCard(cron, NOW)).querySelector(".job-task-kind")!.textContent).toBe("scanning");
    expect(toEl(renderTaskCard({ ...cron, type: "memory_consolidation" }, NOW)).querySelector(".job-task-kind")!.textContent).toBe("dreaming");
    expect(toEl(renderTaskCard({ ...cron, status: "completed" }, NOW)).querySelector(".job-task-kind")!.textContent).toBe("Mission");
  });

  it("shows the elapsed time from its real start", () => {
    expect(toEl(renderTaskCard(cron, NOW)).querySelector(".job-row-time")!.textContent).toBe("1m 05s");
  });

  it("detail is closed by default and open when asked (survives a rebuild through the state map)", () => {
    expect((toEl(renderTaskCard(cron, NOW)).querySelector(".job-row-detail") as HTMLElement).style.display).toBe("none");
    expect((toEl(renderTaskCard(cron, NOW, true)).querySelector(".job-row-detail") as HTMLElement).style.display).toBe("block");
  });

  it("renders the mission report link at render time through the shared chokepoint", () => {
    const el = toEl(renderTaskCard({ ...cron, status: "completed", resultUrl: "/api/cron/j1/reports/latest" }, NOW));
    const link = el.querySelector(".agent-feed-result-link") as HTMLElement;
    expect(link.style.display).toBe("block");
    expect(link.innerHTML).toBe(resultLinkHtml("/api/cron/j1/reports/latest"));
  });
});

describe("renderBackgroundTasks — ambient ops live in the Ambient group, finished ones in the drawer", () => {
  it("groups live ambient ops under a collapsed Ambient head that opens from the state", () => {
    const map = { a: { ...cron, id: "a" }, b: { ...cron, id: "b" } };
    const closed = toEl(renderBackgroundTasks(map, {}, NOW));
    expect(closed.querySelector(".job-ambient")).not.toBeNull();
    expect((closed.querySelector(".job-ambient-list") as HTMLElement).style.display).toBe("none");
    expect(closed.querySelectorAll(".job-ambient .job-task")).toHaveLength(2);
    const open = toEl(renderBackgroundTasks(map, { ambientOpen: true, expanded: { a: 1 } }, NOW));
    expect((open.querySelector(".job-ambient-list") as HTMLElement).style.display).toBe("block");
    expect((open.querySelector("#agent-row-a + .job-row-detail") as HTMLElement).style.display).toBe("block");
    expect((open.querySelector("#agent-row-b + .job-row-detail") as HTMLElement).style.display).toBe("none");
  });

  it("moves a finished ambient op to the Finished drawer and out of the Ambient group", () => {
    const el = toEl(renderBackgroundTasks({ a: { ...cron, id: "a", status: "completed", endedAt: NOW } }, {}, NOW));
    expect(el.querySelector(".job-ambient")).toBeNull();
    expect(el.querySelector(".job-finished-title")!.textContent).toContain("Finished 1");
    expect(el.querySelector(".job-finished .job-task.ok")).not.toBeNull();
  });
});

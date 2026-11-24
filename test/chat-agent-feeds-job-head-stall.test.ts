// @vitest-environment happy-dom
//
// A job's header says STALLED only when the whole job has gone quiet
// (label-check, 2026-11-23). The build orchestrator logs a line between steps
// and nothing while the skeptic it started works, so its header read
// "STALLED 2M 33S" beside a skeptic row marked "working now". The badge was
// also drawn once and never refreshed: it froze at its first value and stayed
// until something else redrew the list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const sources = ["shared-escape.js", "chat-agent-feeds-render.js", "chat-agent-feeds-ambient.js", "chat-agent-feeds-jobs.js", "chat-agent-feeds.js", "chat-agent-feeds-sync.js"].map(read);

type Rec = Record<string, unknown>;
function load() {
  document.body.innerHTML = '<span id="agent-count"></span><div id="agent-feeds-list"></div>';
  const factory = new Function(
    "document",
    "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = false; var setInterval = function() {};\n"
      + sources.join("\n")
      + "\nreturn { addAgentFeed, updateAgentFeed, reconcileAgentFeeds, render: _renderAgentFeedsList, syncJobHeads, data: agentFeedsData };",
  );
  return factory(document) as {
    addAgentFeed: (a: Rec) => void;
    reconcileAgentFeeds: (workers: Rec[]) => void;
    updateAgentFeed: (id: string, u: Rec) => void;
    render: () => void;
    syncJobHeads: (now: number) => void;
    data: Record<string, Rec>;
  };
}

const STALL = 120_000;
const badge = () => document.querySelector(".job-head .job-row-stall");

function buildWithSkeptic(now: number, orchestratorQuietMs: number, skepticQuietMs: number) {
  const api = load();
  api.addAgentFeed({ id: "orch", name: "Worker: Build orchestrator", type: "orchestrator", status: "working", output: "", startedAt: now - 600_000 });
  api.addAgentFeed({ id: "skeptic", name: "Skeptic: chunk 3, Matching", type: "agent", status: "working", output: "", parentOpId: "orch", startedAt: now - 300_000 });
  api.data.orch.lastActivityMs = now - orchestratorQuietMs;
  api.data.skeptic.lastActivityMs = now - skepticQuietMs;
  api.render();
  return api;
}

describe("a job header's stall badge", () => {
  it("stays off while a worker in the job is reporting, though the orchestrator is quiet", () => {
    const now = Date.now();
    const api = buildWithSkeptic(now, STALL + 33_000, 5_000);
    api.syncJobHeads(now);
    expect(document.querySelector(".job-head")).not.toBeNull();
    expect(badge()).toBeNull();
  });

  it("shows when every agent in the job has gone quiet, counted from the latest of them", () => {
    const now = Date.now();
    const api = buildWithSkeptic(now, STALL + 120_000, STALL + 33_000);
    api.syncJobHeads(now);
    expect(badge()!.textContent).toBe("stalled 2m 33s");
  });

  it("ticks with the clock and clears on the tick once a worker speaks again", () => {
    const now = Date.now();
    const api = buildWithSkeptic(now, STALL + 120_000, STALL + 33_000);
    api.syncJobHeads(now);
    api.syncJobHeads(now + 10_000);
    expect(badge()!.textContent).toBe("stalled 2m 43s");

    api.data.skeptic.lastActivityMs = now + 11_000;
    api.syncJobHeads(now + 12_000);
    expect(badge()).toBeNull();
  });

  // The chunk worker is a named agent: its card is fed by agent-output and
  // agent-update frames (chat-ws-handler-misc.js), which carry no activity
  // time. Its row had none, so its job still read STALLED while it worked.
  it("counts a named agent's own output and token updates as activity", () => {
    const api = load();
    const now = Date.now();
    api.addAgentFeed({ id: "orch", name: "Worker: Build orchestrator", type: "orchestrator", status: "working", output: "", startedAt: now - 900_000 });
    api.data.orch.lastActivityMs = now - STALL - 194_000;
    // As the agent-spawn frame adds it: no lastActivityMs of its own.
    api.addAgentFeed({ id: "field-agent-9", name: "Chunk 10/13: Check pipeline", role: "implementer", status: "working", currentTask: "Chunk 10", parentOpId: "orch" });
    api.data["field-agent-9"].lastActivityMs = now - STALL - 60_000;
    api.render();
    api.syncJobHeads(now);
    expect(badge()).not.toBeNull();

    api.updateAgentFeed("field-agent-9", { output: "tool: bash\n" });
    api.syncJobHeads(Date.now());
    expect(badge()).toBeNull();
    expect(api.data["field-agent-9"].lastActivityMs).toBeGreaterThanOrEqual(now);

    api.data["field-agent-9"].lastActivityMs = now - STALL - 60_000;
    api.render();
    api.updateAgentFeed("field-agent-9", { totalTokens: 21_600 });
    api.syncJobHeads(Date.now());
    expect(badge()).toBeNull();
  });

  // After a page load the panel is drawn from the workers snapshot alone. The
  // chunk worker came without its parent, became its own card, and the
  // orchestrator's card read STALLED by itself while the worker ran.
  it("after a reload, nests the chunk worker under its orchestrator and keeps the header live", () => {
    const api = load();
    const started = new Date(Date.now() - 600_000).toISOString();
    api.reconcileAgentFeeds([
      { opId: "orch", sessionId: "s1", task: "Build orchestrator: label-check", status: "running", opType: "orchestrator", startedAt: started },
      { opId: "field-agent-11", sessionId: "s1", task: "Chunk 13/13: Pharmacist card", status: "running", opType: "agent_spawn", parentOpId: "orch", startedAt: started },
    ]);
    api.data.orch.lastActivityMs = Date.now() - STALL - 60_000;
    api.render();
    api.syncJobHeads(Date.now());

    expect(document.querySelectorAll(".job").length).toBe(1);
    expect(document.querySelector('.job [data-agent-row="field-agent-11"]')).not.toBeNull();
    expect(badge()).toBeNull();
  });

  it("starts a new working card's clock when it is added", () => {
    const api = load();
    const before = Date.now();
    api.addAgentFeed({ id: "field-agent-10", name: "Skeptic", status: "working", parentOpId: "orch" });
    expect(api.data["field-agent-10"].lastActivityMs).toBeGreaterThanOrEqual(before);
    api.addAgentFeed({ id: "done-1", name: "Old", status: "completed" });
    expect(api.data["done-1"].lastActivityMs).toBeUndefined();
  });
});

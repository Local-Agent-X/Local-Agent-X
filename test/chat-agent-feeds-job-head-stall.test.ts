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
      + "\nreturn { addAgentFeed, render: _renderAgentFeedsList, syncJobHeads, data: agentFeedsData };",
  );
  return factory(document) as {
    addAgentFeed: (a: Rec) => void;
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
});

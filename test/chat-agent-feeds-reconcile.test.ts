// @vitest-environment happy-dom
//
// The AGENTS panel's cards must match what is actually running (2026-10-26).
// A token-count frame that arrived after a finished agent's card was cleared
// made a new card from the bare frame ("Agent-Update", Running), and nothing
// ever ended it: the desktop built its list from events alone. Now an update
// never makes a card, and every connect reconciles the cards against the
// server's workers_snapshot.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const sources = ["shared-escape.js", "chat-agent-feeds-render.js", "chat-agent-feeds-ambient.js", "chat-agent-feeds-jobs.js", "chat-agent-feeds.js", "chat-agent-feeds-sync.js"].map(read);

type Rec = Record<string, unknown>;
interface Panel {
  updateAgentFeed: (id: string, u: Rec) => void;
  addAgentFeed: (a: Rec) => void;
  removeAgentFeed: (id: string) => void;
  reconcileAgentFeeds: (workers: Rec[]) => void;
  noteWorkersSnapshotAsked: () => void;
  data: () => Record<string, Rec>;
}

function load(): Panel {
  document.body.innerHTML = '<span id="agent-count"></span><div id="agent-feeds-list"></div>';
  const factory = new Function(
    "document",
    "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = false; var setInterval = function() {};\n"
      + sources.join("\n")
      + "\nreturn { updateAgentFeed, addAgentFeed, removeAgentFeed, reconcileAgentFeeds, noteWorkersSnapshotAsked, data: function() { return agentFeedsData; } };",
  );
  return factory(document) as Panel;
}

describe("an update never makes a card", () => {
  it("an update for an id with no card is dropped", () => {
    const p = load();
    p.updateAgentFeed("field-agent-1", { totalTokens: 29_800 });
    expect(p.data()).toEqual({});
  });

  it("a late update after a finished card is cleared does not bring it back", () => {
    const p = load();
    p.addAgentFeed({ id: "field-agent-1", name: "Recipe library", status: "working" });
    p.updateAgentFeed("field-agent-1", { status: "failed" });
    p.removeAgentFeed("field-agent-1");
    p.updateAgentFeed("field-agent-1", { totalTokens: 29_800 });
    expect(p.data()["field-agent-1"]).toBeUndefined();
  });
});

describe("reconciling with the server's live set", () => {
  it("ends a live card the snapshot leaves out, keeps finished ones and listed ones", () => {
    const p = load();
    p.addAgentFeed({ id: "stale", name: "Recipe library", status: "working" });
    p.addAgentFeed({ id: "op_live", name: "Build", status: "working" });
    p.addAgentFeed({ id: "done", name: "Earlier", status: "working" });
    p.updateAgentFeed("done", { status: "succeeded" });
    p.noteWorkersSnapshotAsked();
    p.reconcileAgentFeeds([{ opId: "op_live", sessionId: "s", task: "Build", status: "running" }]);
    expect(Object.keys(p.data()).sort()).toEqual(["done", "op_live"]);
  });

  it("keeps a card this page heard from after it asked — the snapshot may predate it", async () => {
    const p = load();
    p.noteWorkersSnapshotAsked();
    await new Promise((r) => setTimeout(r, 2));
    p.addAgentFeed({ id: "op_new", name: "Just started", status: "working" });
    p.reconcileAgentFeeds([]);
    expect(p.data()["op_new"]).toBeDefined();
  });

  it("draws a worker that started while the page wasn't listening", () => {
    const p = load();
    p.noteWorkersSnapshotAsked();
    p.reconcileAgentFeeds([
      { opId: "op_mid", sessionId: "s", task: "Research pricing", status: "running", opType: "research", lastLine: "✓ turn 3 · read", totalTokens: 1200 },
      { opId: "op_paused", sessionId: "s", task: "Deploy", status: "paused" },
    ]);
    expect(p.data()["op_mid"]).toMatchObject({ name: "Research pricing", status: "working", type: "research", totalTokens: 1200 });
    expect(String(p.data()["op_mid"].output)).toContain("✓ turn 3 · read");
    expect(p.data()["op_paused"]).toMatchObject({ status: "paused" });
  });
});

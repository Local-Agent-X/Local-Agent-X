// @vitest-environment happy-dom
//
// A task card's tokens, tool uses and "Running …" line stay live (2026-10-14).
// The card showed "109.7k tokens · 13 tool uses" while its own expanded worker
// view read "332.1k tok": both come from the same record, but the card's three
// spans were only written when the whole list was rebuilt (a card added, a
// status change), so on a long-running op they froze at whatever the last
// rebuild saw. They are now rewritten from jobTaskStats on every progress
// event and every 1s sync tick, like the elapsed clock beside them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(process.cwd(), "public/js", f), "utf8");
const sources = ["shared-escape.js", "chat-agent-feeds-render.js", "chat-agent-feeds-ambient.js", "chat-agent-feeds-jobs.js", "chat-agent-feeds.js", "chat-agent-feeds-sync.js"].map(read);

function load() {
  document.body.innerHTML = '<span id="agent-count"></span><div id="agent-feeds-list"></div>';
  const factory = new Function(
    "document",
    "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = false; var setInterval = function() {};\n"
      + sources.join("\n")
      + "\nreturn { updateAgentFeed, addAgentFeed };",
  );
  return factory(document) as {
    updateAgentFeed: (id: string, u: Record<string, unknown>) => void;
    addAgentFeed: (a: Record<string, unknown>) => void;
  };
}

const text = (sel: string) => document.querySelector(`#agent-row-op-build ${sel}`)!.textContent;

describe("task card stats", () => {
  it("follow progress events without a rebuild", () => {
    const api = load();
    api.addAgentFeed({ id: "op-build", name: 'Build app "habit-tracker"', type: "app_build", status: "working", output: "", startedAt: Date.now() - 60_000 });
    api.updateAgentFeed("op-build", { output: "✓ turn 0 · bash\n", totalTokens: 109_700 });
    expect(text(".job-task-tokens")).toBe("109.7k tokens");
    expect(text(".job-task-uses")).toBe("1 tool use");

    api.updateAgentFeed("op-build", { output: "✓ turn 1 · write, write, write\n", totalTokens: 332_100 });
    expect(text(".job-task-tokens")).toBe("332.1k tokens");
    expect(text(".job-task-uses")).toBe("4 tool uses");
    expect(text(".job-task-activity")).toBe("Running write, write, write");
    // Same number as the expanded worker view.
    expect(document.querySelector("#agent-card-op-build .worker-token-count")!.textContent).toBe("332.1k tok");
  });

  it("render empty spans until there is something to show (hidden by CSS)", () => {
    const api = load();
    api.addAgentFeed({ id: "op-build", name: "x", type: "app_build", status: "working", output: "", startedAt: Date.now() });
    expect(text(".job-task-tokens")).toBe("");
    expect(text(".job-task-uses")).toBe("");
  });
});

/**
 * A lead that drives its build from one turn, through the whole engine.
 *
 * The lead's turn is scripted as the calls a model would make: build_next's
 * wait, then build_decide for a decision it was handed, then the wait again.
 * Everything else is production: the ask, the channel, the batch stop, fix
 * rounds, real worktrees and merges in a throwaway git repo. Only the chunk
 * worker (runChunkOnce) is stubbed, as in auto-build-incident-replay.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type Scripted = { action: "proceed" | "push_back"; reasoning: string; findings: Array<{ gate: string; action: string; reasoning: string }> };
const script = vi.hoisted(() => ({ outcomes: new Map<number, Scripted[]>(), builds: [] as number[] }));

vi.mock("../src/auto-build/loop/run-chunk-once.js", () => ({
  runChunkOnce: vi.fn(async (opts: { chunk: { number: number; footprint?: string[] }; projectDir: string }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { chunkReportOf } = await import("../src/auto-build/chunk-review/chunk-report.js");
    const n = opts.chunk.number;
    script.builds.push(n);
    const file = opts.chunk.footprint?.[0] ?? `f${n}.txt`;
    fs.writeFileSync(path.join(opts.projectDir, file), `${n}.attempt${script.builds.filter((b) => b === n).length}`);
    const next = script.outcomes.get(n)?.shift() ?? { action: "proceed", reasoning: "green", findings: [] };
    return { ...next, report: chunkReportOf({ status: "done", doneWhen: "met", note: `built part ${n}`, specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" }, [file]) };
  }),
  chunkProcessFailureOutcome: vi.fn(() => null),
}));
vi.mock("../src/auto-build/advisor/index.js", () => ({ consultAdvisor: vi.fn(async () => null) }));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { WORKTREE_BASE } = await import("../src/agency/worktree-core.js");
const { cleanupWorktree } = await import("../src/agency/worktree.js");
const { setChatHandler } = await import("../src/chat-ws/chat-handler.js");
const { acquireTurn, releaseTurn } = await import("../src/session/turn-lock.js");
const { takeForLead, _resetLeadChannels } = await import("../src/auto-build/advisor/lead-channel.js");
const { buildDecideTool } = await import("../src/auto-build/advisor/build-decide-tool.js");

const CHAT = "chat-lead-drives";
const PLAN = ["# Plan", "## Phase A — Build", ...[[1, []], [2, []], [3, [1]]].flatMap(([n, deps]) => [
  `### Chunk ${n} — Part ${n}`,
  "- **Class:** leaf → `/vibe-code`",
  `- **Slice:** create f${n}.txt.`,
  `- **Files:** f${n}.txt`,
  `- **Depends on:** ${(deps as number[]).length ? (deps as number[]).join(", ") : "—"}`,
  `- **Done when:** f${n}.txt exists.`,
])].join("\n");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
const worktreeNames = () => Array.from({ length: 4 }, (_, i) => `autobuild-c${i + 1}`);

let projectDir: string;
let posted: string[];
beforeEach(() => {
  process.env.LAX_BUILD_PREFLIGHT = "0";
  process.env.LAX_SANDBOX = "host";
  script.outcomes.clear(); script.builds = [];
  posted = [];
  _resetLeadChannels();
  setChatHandler(async (_sessionId, message) => { posted.push(message); });
  for (const name of worktreeNames()) { try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* not there */ } }
  projectDir = mkdtempSync(join(tmpdir(), "lead-drives-"));
  git(projectDir, "init", "-q", "-b", "main");
  git(projectDir, "config", "user.email", "lead@example.com");
  git(projectDir, "config", "user.name", "Lead");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "lead-drives", version: "0.0.0", private: true }) + "\n");
  mkdirSync(join(projectDir, "spec"));
  writeFileSync(join(projectDir, "spec", "plan.md"), PLAN);
  git(projectDir, "add", "-A");
  git(projectDir, "commit", "-qm", "init");
});

afterEach(() => {
  releaseTurn(CHAT);
  delete process.env.LAX_BUILD_PREFLIGHT;
  delete process.env.LAX_SANDBOX;
  for (const name of worktreeNames()) {
    try { cleanupWorktree(name); } catch { /* not registered */ }
    try { rmSync(join(WORKTREE_BASE, name), { recursive: true, force: true }); } catch { /* not there */ }
  }
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("a lead driving its build from one turn", () => {
  it("reads each batch and each decision as build_next's result, and the build waits for it between batches", async () => {
    script.outcomes.set(1, [{ action: "push_back", reasoning: "The skeptic broke it: f1.txt is empty for a blank input.", findings: [{ gate: "chunk-skeptic", action: "push_back", reasoning: "f1.txt is empty for a blank input." }] }]);
    acquireTurn(CHAT, new AbortController());
    let done = false;
    const building = runBuildLoop({
      projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(PLAN), startingChunk: 1,
      maxConcurrentChunks: 2, buildLead: { projectDir, originSessionId: CHAT },
    }).finally(() => { done = true; });

    const read: string[] = [];
    const startedWhenRead: number[][] = [];
    for (;;) {
      const { why, items } = await takeForLead(CHAT, { stillRunning: () => !done, userIsWaiting: () => false, pollMs: 20 });
      if (why !== "items") break;
      for (const item of items) {
        read.push(`${item.kind}: ${item.text}`);
        if (item.kind === "decision") {
          await buildDecideTool.execute({ decision_id: item.id, action: "continue", reasoning: "a real gap", instruction: "handle the blank input" }, undefined as never);
        }
        if (item.kind === "batch") {
          // The lead looks at the work before going on: nothing new starts meanwhile.
          await new Promise((r) => setTimeout(r, 300));
          startedWhenRead.push([...new Set(script.builds)]);
        }
      }
    }
    const result = await building;

    expect(result.status).toBe("complete");
    expect(result.chunksCommitted).toBe(3);
    const decisions = read.filter((r) => r.startsWith("decision:"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain("f1.txt is empty for a blank input");
    const batches = read.filter((r) => r.startsWith("batch:"));
    expect(batches).toHaveLength(2);
    // The first batch reports both chunks, the one that passed first time included.
    expect(batches[0]).toContain("2 of 2 chunk(s) landed");
    expect(batches[0]).toContain('Chunk 2/3, "Part 2": landed.');
    expect(batches[0]).toContain("built part 2");
    expect(batches[1]).toContain('Chunk 3/3, "Part 3": landed.');
    // Chunk 3 was not started while the lead was still reading batch one.
    expect(startedWhenRead[0]).toEqual([1, 2]);
    // The lead answered in its turn, so nothing was posted into the chat.
    releaseTurn(CHAT);
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toEqual([]);
  }, 120_000);
});

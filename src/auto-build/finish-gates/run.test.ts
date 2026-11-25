// The finish gates: when a build lands its plan's last chunk, the engine
// judges the whole app and attacks it before calling it done, fixes what it
// finds within its bounds, and names what is left. label-check's build ended
// at its last chunk and its chat asked the owner whether to start them
// (2026-11-23).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFinishGates, type SuiteJudging } from "./run.js";
import type { BreakerResult } from "./breakers.js";
import type { LoopOptions, LoopResult } from "../loop/types.js";
import type { ParsedChunk } from "../plan-parser.js";

const chunk = (n: number): ParsedChunk => ({ number: n, title: `c${n}`, phase: "Phase A", klass: "leaf", slice: "s", dependsOn: [], scenarios: "—", doneWhen: "d", rawSection: "" });
const dir = mkdtempSync(join(tmpdir(), "lax-finish-"));
const opts = (over: Partial<LoopOptions> = {}): LoopOptions => ({
  projectDir: dir, planPath: join(dir, "spec", "plan.md"), plan: { title: "p", chunks: [chunk(1), chunk(2)], phaseGatesRawSection: "", launchReadinessRows: [] } as never,
  startingChunk: 1, finishGates: true, ...over,
});
const done = (over: Partial<LoopResult> = {}): LoopResult => ({ status: "complete", lastChunk: 2, chunksCommitted: 2, haltReason: "", outcomes: [], events: [], ...over });
const failing = (file: string): SuiteJudging["failed"][number] => ({
  scenarioPath: `/h/${file}`, scenarioTitle: file, score: 3, passed: false, steps: [], metCriteria: [], failedCriteria: ["flag shown"], reasoning: "no flag", durationMs: 1,
});
const breakers = (...found: Array<Array<[BreakerResult["findings"][number]["severity"], string]>>) =>
  found.map((f, i): BreakerResult => ({ persona: ["hostile", "unlucky", "auditor", "quality"][i], status: "ran", findings: f.map(([severity, text]) => ({ severity, text })) }));

function harness(rounds: Array<{ suite: SuiteJudging; found: BreakerResult[] }>, fixResult: Partial<LoopResult> = {}) {
  let round = 0;
  const said: string[] = [];
  const buildFixes = vi.fn(async (o: LoopOptions) => ({ ...done(), chunksCommitted: o.plan.chunks.length, ...fixResult }));
  const judgeSuite = vi.fn(async () => rounds[Math.min(round, rounds.length - 1)].suite);
  const runBreakers = vi.fn(async () => rounds[Math.min(round++, rounds.length - 1)].found);
  return { said, buildFixes, judgeSuite, runBreakers, emit: (e: { message: string }) => { said.push(e.message); } };
}
const run = (h: ReturnType<typeof harness>, o = opts(), r = done()) =>
  runFinishGates({ opts: o, result: r, emit: h.emit, buildFixes: h.buildFixes, judgeSuite: h.judgeSuite, breakers: h.runBreakers as never });

describe("runFinishGates", () => {
  it("runs only for a build that opted in and landed the plan's last chunk", async () => {
    const h = harness([{ suite: { failed: [], unjudged: [] }, found: [] }]);
    expect(await run(h, opts({ finishGates: false }))).toEqual(done());
    expect(await run(h, opts(), done({ status: "halted", haltReason: "x" }))).toMatchObject({ status: "halted" });
    expect(await run(h, opts(), done({ lastChunk: 1 }))).toEqual(done({ lastChunk: 1 }));
    expect(h.runBreakers).not.toHaveBeenCalled();
  });

  it("a clean app: one round, no fixes, and only the checks a person must make are left open", async () => {
    const h = harness([{ suite: { failed: [], unjudged: [] }, found: breakers([], [], [], []) }]);
    const out = await run(h);
    expect(h.buildFixes).not.toHaveBeenCalled();
    expect(out.status).toBe("complete");
    expect(out.openItems).toEqual(["the owner's walkthrough of the finished app is still to do"]);
  });

  it("turns failing scenarios and medium-or-worse findings into fix chunks, lists the low ones, then checks again", async () => {
    const h = harness([
      { suite: { failed: [failing("05-scan.md")], unjudged: [] }, found: breakers([["critical", "tab leak"]], [["low", "label clips"]], [], []) },
      { suite: { failed: [], unjudged: [] }, found: breakers([], [], [], []) },
    ]);
    const out = await run(h);
    expect(h.buildFixes).toHaveBeenCalledTimes(1);
    const fixOpts = h.buildFixes.mock.calls[0][0];
    expect(fixOpts.plan.chunks.map((c) => [c.number, c.title, c.scenarios])).toEqual([
      [1011, "Finish fix 1: failing scenarios", "05"],
      [1012, "Finish fix 1: hostile findings", "—"],
    ]);
    expect(fixOpts).toMatchObject({ skipWallProbe: true, finishGates: false, maxConcurrentChunks: 1, startingChunk: 1011 });
    expect(fixOpts.plan.chunks[1].slice).toContain("[critical] tab leak");
    expect(out.chunksCommitted).toBe(4);
    expect(out.openItems).toEqual(["unlucky [low]: label clips", "the owner's walkthrough of the finished app is still to do"]);
  });

  it("stops when a round's fixes moved nothing, naming what is still open", async () => {
    const stuck = { suite: { failed: [failing("05-scan.md")], unjudged: [] }, found: breakers([], [], [], []) };
    const h = harness([stuck, stuck]);
    const out = await run(h);
    expect(h.buildFixes).toHaveBeenCalledTimes(1);
    expect(out.openItems?.[0]).toBe("scenario 05-scan.md fails (3/10): no flag");
    expect(h.said.some((m) => m.includes("did not move them"))).toBe(true);
  });

  it("at most two fix rounds; the third check only reports", async () => {
    const h = harness([
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "a"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "b"]], [["medium", "c"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "d"]]) },
    ]);
    const out = await run(h);
    expect(h.buildFixes).toHaveBeenCalledTimes(2);
    expect(out.openItems).toContain("hostile [high]: d");
    expect(h.said.some((m) => m.includes("fix rounds used up"))).toBe(true);
  });

  it("with a lead, the lead decides whether to fix again once the two rounds are spent, up to four", async () => {
    const h = harness([
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "a"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "b"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "c"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "d"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "e"]]) },
    ]);
    const askLead = vi.fn(async (_lead: unknown, _s: unknown) => ({ action: "continue" as const, reasoning: "still worth it" }));
    const out = await runFinishGates({
      opts: opts({ buildLead: { projectDir: dir, originSessionId: "chat-x" } }), result: done(), emit: h.emit,
      buildFixes: h.buildFixes, judgeSuite: h.judgeSuite, breakers: h.runBreakers as never, askLead,
    });
    expect(h.buildFixes).toHaveBeenCalledTimes(4);
    expect(askLead).toHaveBeenCalledTimes(2);
    expect(askLead.mock.calls[0][1]).toMatchObject({ kind: "finish", evidence: expect.stringContaining("hostile [high]: c") });
    expect(out.openItems).toContain("hostile [high]: e");
  });

  it("a lead that says accept ends at the two rounds, listing what is open", async () => {
    const h = harness([
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "a"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "b"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "c"]]) },
    ]);
    const askLead = vi.fn(async () => ({ action: "accept" as const, reasoning: "enough" }));
    const out = await runFinishGates({
      opts: opts({ buildLead: { projectDir: dir, originSessionId: "chat-x" } }), result: done(), emit: h.emit,
      buildFixes: h.buildFixes, judgeSuite: h.judgeSuite, breakers: h.runBreakers as never, askLead,
    });
    expect(h.buildFixes).toHaveBeenCalledTimes(2);
    expect(out.openItems).toContain("hostile [high]: c");
  });

  it("a fix round that does not land is an open item, and the build still ends complete", async () => {
    const h = harness([
      { suite: { failed: [], unjudged: [] }, found: breakers([["high", "a"]]) },
      { suite: { failed: [], unjudged: [] }, found: breakers([]) },
    ], { status: "halted", haltReason: "chunk 1011 set aside", chunksCommitted: 0 });
    const out = await run(h);
    expect(out.status).toBe("complete");
    expect(out.openItems?.[0]).toBe("finish fix round 1 did not fully land: chunk 1011 set aside");
  });

  it("lists every chunk that landed with a check that never ran on it", async () => {
    const h = harness([{ suite: { failed: [], unjudged: [] }, found: [] }]);
    const outcome = { action: "proceed", reasoning: "", findings: [], report: {} as never, unverified: "`npm run build` could not run (cage pending), so the chunk's code was not built or tested" };
    const out = await run(h, opts(), done({ outcomes: [{ chunkNumber: 2, outcome: outcome as never, action: "proceed" }] }));
    expect(out.openItems?.[0]).toBe("chunk 2 landed unverified: `npm run build` could not run (cage pending), so the chunk's code was not built or tested");
  });

  it("a phone app is also owed a run on a device", async () => {
    const mobile = mkdtempSync(join(tmpdir(), "lax-finish-mobile-"));
    writeFileSync(join(mobile, "app.json"), "{}");
    const h = harness([{ suite: { failed: [], unjudged: [] }, found: [] }]);
    const out = await run(h, opts({ projectDir: mobile }));
    expect(out.openItems?.[0]).toContain("has not been run on a phone or emulator");
  });
});

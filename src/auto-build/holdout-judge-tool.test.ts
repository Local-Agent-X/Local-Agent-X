// What holdout_judge tells the agent. label-check's whole-suite judging read
// "0 of 18 passed" four times while most scenarios were never judged (a judge
// reply that did not parse, a server that was gone), and the agent moved on
// believing the app had failed (2026-11-24).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ outcome: null as unknown }));
vi.mock("./scenario-scorer/phase-gate-runner.js", () => ({ scoreScenarioFiles: vi.fn(async () => fake.outcome) }));

const { holdoutJudgeTool } = await import("./holdout-judge-tool.js");
const { writeScenario } = await import("../holdout/store.js");

const DATA = mkdtempSync(join(tmpdir(), "lax-holdout-judge-"));
const prior = process.env.LAX_DATA_DIR;
const project = join(DATA, "apps", "pillbox");
beforeAll(() => {
  process.env.LAX_DATA_DIR = DATA;
  mkdirSync(project, { recursive: true });
  writeScenario("pillbox", "01-add.md", "x");
  writeScenario("pillbox", "02-check.md", "x");
  writeScenario("pillbox", "03-about.md", "x");
});
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const report = (file: string, over: Record<string, unknown>) => ({
  scenarioPath: join(DATA, "holdout", "pillbox", file), scenarioTitle: file, score: 8, passed: true,
  steps: [], metCriteria: [], failedCriteria: [], reasoning: "fine", durationMs: 1, ...over,
});
const judge = async () => (await holdoutJudgeTool.execute({ project_dir: project }, undefined as never)) as { content: string; isError?: boolean };

describe("holdout_judge", () => {
  it("counts passed, failed and could-not-judge apart, and names why one was not judged", async () => {
    writeFileSync(join(project, ".lax-launch.json"), JSON.stringify({ start: "npm start", ready_url: "http://127.0.0.1:7070/" }));
    fake.outcome = {
      kind: "failures",
      reports: [
        report("01-add.md", {}),
        report("02-check.md", { score: 3, passed: false, reasoning: "no flag shown" }),
        report("03-about.md", { score: 0, passed: false, abortReason: "judge returned unparseable response" }),
      ],
      failedReports: [], unjudgedReports: [],
    };
    const out = await judge();
    expect(out.content).toContain("Judged 3 scenarios for pillbox: 1 passed, 1 failed, 1 could not be judged");
    expect(out.content).toContain("- 03-about.md: could not judge (tried twice): judge returned unparseable response");
    expect(out.content).toContain("- 02-check.md: fail, 3/10. no flag shown");
  });

  it("a launch file with the wrong keys is named, with the shape to write", async () => {
    writeFileSync(join(project, ".lax-launch.json"), JSON.stringify({ command: "node serve.mjs", port: 7070 }));
    const out = await judge();
    expect(out.isError).toBe(true);
    expect(out.content).toContain("has no start and ready_url (it has: command, port)");
  });
});

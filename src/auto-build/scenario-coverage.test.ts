// Read before a build starts: a sealed scenario no chunk names refuses the
// run, and what the run will not check is said once. label-check's plan named
// scenarios on 2 of 13 chunks, and nothing said so (2026-11-23).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScenario } from "../holdout/store.js";
import { parsePlanText } from "./plan-parser.js";
import { planCoverageNotes, planCoverageProblem } from "./scenario-coverage.js";
import { createBuildPlanKickoff } from "./kickoff.js";

const DATA = mkdtempSync(join(tmpdir(), "lax-coverage-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => {
  process.env.LAX_DATA_DIR = DATA;
  for (const f of ["01-add-med.md", "02-check.md", "03-about.md"]) writeScenario("pillbox", f, "x");
});
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});

const chunk = (n: number, scenarios: string) => [
  `### Chunk ${n} — Part ${n}`, "- **Class:** leaf", "- **Slice:** s", "- **Depends on:** —", `- **Scenarios:** ${scenarios}`, "- **Done when:** d",
].join("\n");
const planText = (scenarios: string[], gates = true) => [
  "# Plan", "## Phase A — Build", ...scenarios.map((s, i) => chunk(i + 1, s)),
  ...(gates ? ["## Phase verification gates", "- Phase A: scenarios 1-3"] : []),
].join("\n");
const project = (name: string) => { const dir = join(DATA, "apps", name); mkdirSync(join(dir, "spec"), { recursive: true }); return dir; };

describe("planCoverageProblem", () => {
  it("names the sealed scenarios no chunk gives a home", () => {
    const why = planCoverageProblem(project("pillbox"), parsePlanText(planText(["—", "1, 2 (partial)", "2"])));
    expect(why).toContain("gives 1 of the 3 sealed scenarios to no chunk: 03-about.md");
  });

  it("is null when every scenario is named, or the project has no suite", () => {
    expect(planCoverageProblem(project("pillbox"), parsePlanText(planText(["1", "2, 3"])))).toBeNull();
    expect(planCoverageProblem(project("no-suite"), parsePlanText(planText(["—"])))).toBeNull();
  });
});

describe("planCoverageNotes", () => {
  it("says when there is no sealed suite and no phase gates", () => {
    expect(planCoverageNotes(project("no-suite"), parsePlanText(planText(["—"], false)))).toEqual([
      "This project has no sealed scenario suite, so chunks are checked by their build, tests and the skeptic only.",
      "spec/plan.md has no \"Phase verification gates\" section, so no phase is scored when it ends.",
    ]);
    expect(planCoverageNotes(project("pillbox"), parsePlanText(planText(["1, 2, 3"])))).toEqual([]);
  });
});

describe("run_build_plan's kickoff", () => {
  const start = vi.fn(() => ({ opId: "op_x", initialMessage: "Build orchestrator started." }));

  it("refuses a plan that leaves a sealed scenario to no chunk, before anything starts", async () => {
    const dir = project("pillbox");
    writeFileSync(join(dir, "spec", "plan.md"), planText(["1", "2"]));
    const out = await createBuildPlanKickoff({ start })({ projectDir: dir });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("03-about.md");
    expect(start).not.toHaveBeenCalled();
  });

  it("starts a run that will not be fully checked, and says what it will not check", async () => {
    const dir = project("no-suite");
    writeFileSync(join(dir, "spec", "plan.md"), planText(["—"], false));
    const out = await createBuildPlanKickoff({ start })({ projectDir: dir });
    expect(start).toHaveBeenCalledOnce();
    expect(out.content).toContain("Not checked in this run:\n- This project has no sealed scenario suite");
  });
});

// The wall probe: after the first landed chunk, prove the judge can start the
// app and reach a verdict before the rest of the build goes on. label-check's
// judge never could, and thirteen chunks landed unscored (2026-11-23).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ outcome: null as unknown, calls: [] as string[][], halts: [] as unknown[] }));
vi.mock("../scenario-scorer/phase-gate-runner.js", () => ({
  scoreScenarioFiles: vi.fn(async (o: { scenarioPaths: string[] }) => { fake.calls.push(o.scenarioPaths); return fake.outcome; }),
}));
vi.mock("../git-helpers.js", () => ({ leavingTrackedFilesAsFound: async (_d: string, run: () => Promise<unknown>) => ({ value: await run(), restored: [] }) }));
vi.mock("../failure-recovery.js", () => ({ appendHalt: (_d: string, r: unknown) => { fake.halts.push(r); } }));

const { createWallProbe } = await import("./wall-probe.js");
const { writeScenario } = await import("../../holdout/store.js");

const DATA = mkdtempSync(join(tmpdir(), "lax-wall-probe-"));
const prior = process.env.LAX_DATA_DIR;
beforeAll(() => {
  process.env.LAX_DATA_DIR = DATA;
  writeScenario("pillbox", "01-add.md", "x");
  writeScenario("pillbox", "02-check.md", "x");
});
afterAll(() => {
  if (prior === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prior;
  rmSync(DATA, { recursive: true, force: true });
});
beforeEach(() => { fake.outcome = null; fake.calls = []; fake.halts = []; });

function scope() {
  const said: string[] = [];
  return { said, s: { opts: {} as never, totalChunks: 13, emit: (e: { message: string }) => { said.push(e.message); }, events: [], outcomes: [] } };
}
const project = (name: string) => { const dir = join(DATA, "apps", name); mkdirSync(dir, { recursive: true }); return dir; };
const launch = (dir: string) => writeFileSync(join(dir, ".lax-launch.json"), JSON.stringify({ start: "npm start", ready_url: "http://127.0.0.1:7070/" }));
const report = (over: Record<string, unknown>) => ({ scenarioPath: "01-add.md", scenarioTitle: "add", score: 4, passed: false, steps: [], metCriteria: [], failedCriteria: [], reasoning: "", durationMs: 1, ...over });

describe("the wall probe", () => {
  it("a project with no sealed suite has nothing to probe", async () => {
    const probe = createWallProbe({ projectDir: project("no-suite") });
    expect(await probe.afterLanding(scope().s, 1, 1)).toEqual({ kind: "ok" });
    expect(fake.calls).toEqual([]);
  });

  it("waits, saying so once, until the launch file exists; then probes once with one scenario", async () => {
    const dir = project("pillbox");
    const probe = createWallProbe({ projectDir: dir });
    const { said, s } = scope();
    await probe.afterLanding(s, 1, 1);
    await probe.afterLanding(s, 2, 2);
    expect(said.filter((m) => m.startsWith("judge check waits"))).toHaveLength(1);
    expect(fake.calls).toEqual([]);

    launch(dir);
    // A failure the app earned is still a verdict: the harness works.
    fake.outcome = { kind: "failures", reports: [report({})], failedReports: [report({})], unjudgedReports: [] };
    expect(await probe.afterLanding(s, 3, 3)).toEqual({ kind: "ok" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].map((p) => p.split(/[\\/]/).pop())).toEqual(["01-add.md"]);
    expect(said.at(-1)).toBe("judge check passed: the judge started the app and scored 01-add.md (4/10)");
    await probe.afterLanding(s, 4, 4);
    expect(fake.calls).toHaveLength(1);
  });

  it("halts the build, with the reason, when the judge cannot start the app", async () => {
    const dir = project("pillbox"); launch(dir);
    fake.outcome = { kind: "error", reason: "something is already answering at http://127.0.0.1:7070/" };
    const out = await createWallProbe({ projectDir: dir }).afterLanding(scope().s, 1, 1);
    expect(out.kind).toBe("halt");
    if (out.kind !== "halt") return;
    expect(out.result.haltReason).toContain("every chunk from here would land unverified: something is already answering");
    expect(fake.halts).toMatchObject([{ chunk: 1, gate: "wall-probe" }]);
  });

  it("halts when the scenario could not be judged even on a second try", async () => {
    const dir = project("pillbox"); launch(dir);
    const crashed = report({ abortReason: "judge returned unparseable response" });
    fake.outcome = { kind: "unjudged", reports: [crashed], unjudgedReports: [crashed] };
    const out = await createWallProbe({ projectDir: dir }).afterLanding(scope().s, 1, 1);
    expect(out.kind === "halt" && out.result.haltReason).toContain("could not be judged twice: judge returned unparseable response");
  });
});

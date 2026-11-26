// The wall probe: after the first landed chunk, prove the judge can start the
// app and reach a verdict before the rest of the build goes on. label-check's
// judge never could, and thirteen chunks landed unscored (2026-11-23).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ outcome: null as unknown, calls: [] as string[][], halts: [] as unknown[], owed: [] as Array<{ check: string; why: string }> }));
vi.mock("../scenario-scorer/phase-gate-runner.js", () => ({
  scoreScenarioFiles: vi.fn(async (o: { scenarioPaths: string[] }) => { fake.calls.push(o.scenarioPaths); return fake.outcome; }),
}));
vi.mock("../git-helpers.js", () => ({ leavingTrackedFilesAsFound: async (_d: string, run: () => Promise<unknown>) => ({ value: await run(), restored: [] }) }));
vi.mock("../failure-recovery.js", () => ({
  appendHalt: (_d: string, r: unknown) => { fake.halts.push(r); },
  recordOwed: (_d: string, o: { check: string; why: string }) => { fake.owed.push(o); },
}));

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
beforeEach(() => { fake.outcome = null; fake.calls = []; fake.halts = []; fake.owed = []; });

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

  // label-check-sol (2026-11-25): what the judge lacked was a device and a
  // cloud project only the owner had.
  it("with a lead, an owed check lets the build go on, on record; a park or no answer halts", async () => {
    const dir = project("pillbox"); launch(dir);
    fake.outcome = { kind: "error", reason: "no device attached" };
    const lead = { projectDir: dir, originSessionId: "chat-x" };
    const owed = vi.fn(async () => ({ action: "owed" as const, reasoning: "only the owner has a phone", owedCheck: "judge on a Pixel with the owner's account" }));
    const { said, s } = scope();
    expect(await createWallProbe({ projectDir: dir, buildLead: lead }, owed).afterLanding(s, 1, 1)).toEqual({ kind: "ok" });
    expect(said.at(-1)).toContain("judge check owed to the owner");
    expect(fake.halts).toEqual([]);
    // On the build's ledger, where the finish report and a restart find it.
    expect(fake.owed).toEqual([{ check: "judge check", why: expect.stringContaining("judge on a Pixel with the owner's account") }]);

    const parked = vi.fn(async () => ({ action: "park" as const, reasoning: "r", question: "fix the launch file?" }));
    expect((await createWallProbe({ projectDir: dir, buildLead: lead }, parked).afterLanding(scope().s, 1, 1)).kind).toBe("halt");
    expect((await createWallProbe({ projectDir: dir, buildLead: lead }, vi.fn(async () => null)).afterLanding(scope().s, 1, 1)).kind).toBe("halt");
  });

  // What this machine stopped is nobody's to fix in the build: it used to halt
  // a build with no lead, and ask one that had a lead a question with one answer.
  it("the judge's own trouble starting the app on this machine is owed without asking, lead or no lead", async () => {
    const dir = project("pillbox"); launch(dir);
    fake.outcome = { kind: "error", reason: "dev server failed to start: something is already answering at http://127.0.0.1:5173/", harness: true };
    const ask = vi.fn(async () => null);
    for (const buildLead of [undefined, { projectDir: dir, originSessionId: "chat-x" }]) {
      expect(await createWallProbe({ projectDir: dir, ...(buildLead ? { buildLead } : {}) }, ask).afterLanding(scope().s, 1, 1)).toEqual({ kind: "ok" });
    }
    expect(ask).not.toHaveBeenCalled();
    expect(fake.halts).toEqual([]);
    expect(fake.owed).toHaveLength(2);
    expect(fake.owed[0].why).toContain("could not start the app on this machine");
  });
});

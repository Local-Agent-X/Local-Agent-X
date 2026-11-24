// The one scoring run (scoreScenarioFiles) keeps three answers apart: a pass,
// a failure the app earned, and a scenario the harness could not judge. Before,
// a judge that returned garbage or a browser that hit a dead port read as
// "fail, 0/10", and label-check's suite came back "0 of 18 passed" with most of
// them crashes (2026-11-24).
import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => ({
  exitCode: null as number | null,
  results: [] as Array<Record<string, unknown>>,
  calls: 0,
  stopped: 0,
}));
vi.mock("./app-launcher.js", () => ({
  launchApp: vi.fn(async () => ({
    proc: { get exitCode() { return fake.exitCode; } },
    stop: async () => { fake.stopped++; },
    stdout: [], stderr: ["listen EADDRINUSE\n"], url: "http://127.0.0.1:7070/",
  })),
}));
vi.mock("./parser.js", () => ({ parseScenarioFile: (path: string) => ({ path, title: path }) }));
vi.mock("./scorer.js", () => ({
  scoreScenario: vi.fn(async (opts: { scenario: { path: string } }) => {
    fake.calls++;
    const { exitAfter, ...next } = (fake.results.shift() ?? {}) as { exitAfter?: number };
    if (exitAfter !== undefined) fake.exitCode = exitAfter;
    return { scenarioPath: opts.scenario.path, scenarioTitle: opts.scenario.path, score: 8, passed: true, steps: [], metCriteria: [], failedCriteria: [], reasoning: "", durationMs: 1, ...next };
  }),
}));

const { scoreScenarioFiles } = await import("./phase-gate-runner.js");
const launch = { start: "npm start", readyUrl: "http://127.0.0.1:7070/", readyTimeoutMs: 5000 };
const run = (paths: string[]) => scoreScenarioFiles({ projectDir: "/proj", launch, scenarioPaths: paths });
const crash = (reason: string) => ({ score: 0, passed: false, abortReason: reason });

beforeEach(() => { fake.exitCode = null; fake.results = []; fake.calls = 0; fake.stopped = 0; });

describe("scoreScenarioFiles", () => {
  it("tries a scenario the harness could not judge once more, and takes the second answer", async () => {
    fake.results = [crash("judge returned unparseable response"), { score: 9, passed: true }];
    const out = await run(["01-a.md"]);
    expect(fake.calls).toBe(2);
    expect(out.kind).toBe("proceed");
  });

  it("twice unjudged is its own outcome, never a failure", async () => {
    fake.results = [crash("judge timeout"), crash("judge timeout"), { score: 8, passed: true }];
    const out = await run(["01-a.md", "02-b.md"]);
    expect(out.kind).toBe("unjudged");
    if (out.kind !== "unjudged") return;
    expect(out.unjudgedReports.map((r) => r.scenarioPath)).toEqual(["01-a.md"]);
  });

  it("a real failure is reported as one, with the unjudged kept apart", async () => {
    fake.results = [{ score: 3, passed: false }, crash("x"), crash("x")];
    const out = await run(["01-a.md", "02-b.md"]);
    expect(out.kind).toBe("failures");
    if (out.kind !== "failures") return;
    expect(out.failedReports.map((r) => r.scenarioPath)).toEqual(["01-a.md"]);
    expect(out.unjudgedReports.map((r) => r.scenarioPath)).toEqual(["02-b.md"]);
  });

  it("an app that stops running mid-suite is the app failing, said with its exit", async () => {
    // The first scenario's scoring sees a live app; by the second it has exited.
    fake.results = [{ score: 8, passed: true, exitAfter: 1 }];
    const out = await run(["01-a.md", "02-b.md"]);
    expect(fake.calls).toBe(1);
    expect(out).toMatchObject({ kind: "error" });
    if (out.kind === "error") expect(out.reason).toContain("stopped running during scoring (exit code 1)");
    expect(fake.stopped).toBe(1);
  });
});

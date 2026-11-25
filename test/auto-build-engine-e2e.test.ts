/**
 * The build engine end to end: a tiny app built chunk by chunk through the
 * real loop, with nothing between the pieces faked.
 *
 * Every stop label-check and label-check-sol hit on 2026-11-23/24 was at a seam
 * between pieces that each passed their own tests: a launch file read under
 * the wrong keys, a judge scoring a server it did not start, a flag handed to
 * a script that did not take it, a check that could not run read as a pass.
 * This file runs those seams for real: git, the per-chunk build and test
 * check, the launch file, the app's own server, a real browser driving the
 * sealed scenarios, the wall probe, the fix rounds, a stopped run resumed and
 * the finish gates. Only what a model would say is scripted: the workers'
 * edits and reports, the skeptic, the break-it agents, the advisor, and the
 * step planner's and judge's replies (decided from what the browser saw).
 *
 * Needs a launchable chromium (Playwright's); without one the suite says so
 * and skips, as the other browser suites do.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";

/** What each scripted worker writes, by chunk and attempt (1-based). */
type Edit = (dir: string, port: number) => void;
const script = vi.hoisted(() => ({
  port: 0,
  edits: new Map<number, Edit[]>(),
  attempts: new Map<number, number>(),
  tasks: [] as Array<{ chunk: number; task: string }>,
  breakerFindings: "FINDINGS: none",
}));

const CLEAN = (changed: string) =>
  `STATUS: done\nDONE_WHEN: met\nCHANGED: ${changed}\nTESTS: 1/1\nNEW_FAILURES: none\nPRE_EXISTING_FAILURES: none\n` +
  `SPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: done.`;

// Only what the engine imports from the agent module, with no real module
// behind it: loading the real one here let a caller reach its runner.
vi.mock("../src/auto-build/agents/chunk-runner.js", async () => {
  const { readFileSync: read, writeFileSync: write, copyFileSync } = await import("node:fs");
  const { join: at } = await import("node:path");
  return {
    SKEPTIC_PROBE_DIR: ".skeptic",
    runChunkAgent: vi.fn(async (o: { role: string; title?: string; task: string; projectDir: string }) => {
      const done = (stdout: string) => ({ stdout, exitCode: 0, durationMs: 1 });
      if (o.role === "chunk-skeptic") return done("VERDICT: HOLDS\nFINDING: ran the app's checks and probed the edges.\nFOLLOW_UPS: none");
      if (o.role === "finish-breaker") return done(script.breakerFindings);
      if (o.title === "Build preflight check") {
        const token = read(at(o.projectDir, ".lax-preflight-sentinel.txt"), "utf-8").trim();
        write(at(o.projectDir, ".lax-preflight-echo.txt"), token);
        copyFileSync(at(o.projectDir, ".lax-preflight-echo.txt"), at(o.projectDir, ".lax-preflight-bash.txt"));
        return done(CLEAN(".lax-preflight-echo.txt").replace("NOTE: done.", `NOTE: preflight token ${token}`));
      }
      const chunk = Number((o.title ?? "").match(/Chunk (\d+)\//)?.[1] ?? o.task.match(/Chunk (\d+)/)?.[1]);
      const attempt = (script.attempts.get(chunk) ?? 0) + 1;
      script.attempts.set(chunk, attempt);
      script.tasks.push({ chunk, task: o.task });
      const edits = script.edits.get(chunk) ?? [];
      (edits[attempt - 1] ?? edits[edits.length - 1])?.(o.projectDir, script.port);
      return done(CLEAN("index.html"));
    }),
  };
});
vi.mock("../src/auto-build/advisor/index.js", () => ({ consultAdvisor: vi.fn(async () => null) }));

const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { defaultChunkJudge } = await import("../src/auto-build/chunk-review/chunk-judge.js");
const { writeScenario } = await import("../src/holdout/store.js");
const stepPlanner = await import("../src/auto-build/scenario-scorer/step-planner.js");
const judge = await import("../src/auto-build/scenario-scorer/judge.js");

const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch { return false; }
})();

// ── The scripted model replies: decided from what the real browser saw ──

// A step with a quoted phrase checks the page shows it; any other step is the
// persona opening the app, which the driver already did.
stepPlanner._setLlmCallForTests(async (prompt: string) => {
  const step = prompt.match(/^Step \d+: (.*)$/m)?.[1] ?? "";
  const quoted = step.match(/"([^"]+)"/)?.[1];
  return JSON.stringify(quoted
    ? { action: "assert-text", selector: null, value: quoted, reason: "check", confidence: 0.9 }
    : { action: "skip", selector: null, value: null, reason: "opening the app", confidence: 0.9 });
});
// The judge passes a scenario whose every step ran clean, and fails one with a failed step.
judge._setLlmCallForTests(async (prompt: string) => {
  const failed = /^\s*\[\d+\] FAIL:/m.test(prompt);
  return JSON.stringify(failed
    ? { score: 3, met_criteria: [], failed_criteria: ["the page shows what the step expects"], reasoning: "A checked phrase is not on the page." }
    : { score: 9, met_criteria: ["every checked phrase is on the page"], failed_criteria: [], reasoning: "Every step ran clean." });
});

// ── The fixture app ──

const SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
createServer((_q, s) => { s.setHeader("content-type", "text/html"); s.end(readFileSync("index.html")); })
  .listen(Number(process.argv[2]), "127.0.0.1");
`;
const page = (body: string) => `<!doctype html><html><head><title>Pillbox</title></head><body>${body}</body></html>`;
const launchFile = (port: number) => JSON.stringify({ start: `node serve.mjs ${port}`, ready_url: `http://127.0.0.1:${port}/` });

const foundation: Edit = (dir, port) => {
  writeFileSync(join(dir, "serve.mjs"), SERVER);
  writeFileSync(join(dir, "index.html"), page("<h1>Pillbox</h1>"));
  writeFileSync(join(dir, ".lax-launch.json"), launchFile(port));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pillbox", private: true, scripts: { build: "node -e \"\"", test: "node -e \"\"" } }));
};
const addMeds: Edit = (dir) => writeFileSync(join(dir, "index.html"), page("<h1>Pillbox</h1><p>Add medication</p>"));
const checkScreen = (text: string): Edit => (dir) =>
  writeFileSync(join(dir, "index.html"), page(`<h1>Pillbox</h1><p>Add medication</p><p>${text}</p>`));

const PLAN = [
  "# Plan — Pillbox",
  "## Phase A — Build",
  ...[[1, "Foundation", "1"], [2, "Add medication", "—"], [3, "Check screen", "2"]].map(([n, title, scenarios]) => [
    `### Chunk ${n} — ${title}`, "- **Class:** leaf → `/vibe-code`", `- **Slice:** ${title}.`,
    `- **Depends on:** ${n === 1 ? "—" : n - 1}`, `- **Scenarios:** ${scenarios}`, `- **Done when:** ${title} works.`, "",
  ].join("\n")),
].join("\n");

const scenario = (title: string, phrase: string) =>
  `# ${title}\n\n**Persona:** someone checking a supplement.\n\n**Steps:**\n1. Open the app.\n2. See "${phrase}" on the page.\n\n**Pass criteria:** the page shows "${phrase}".\n`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let projectDir: string;
const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: "pipe" }).toString();

beforeEach(async () => {
  script.port = await freePort();
  script.edits = new Map([[1, [foundation]], [2, [addMeds]], [3, [checkScreen("No known flags")]]]);
  script.attempts = new Map();
  script.tasks = [];
  script.breakerFindings = "FINDINGS: none";
  projectDir = join(mkdtempSync(join(tmpdir(), "lax-engine-e2e-")), `pillbox-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(projectDir, "spec"), { recursive: true });
  writeFileSync(join(projectDir, "spec", "plan.md"), PLAN);
  git("init -q -b main");
  git("-c user.email=e2e@lax.test -c user.name=e2e add -A");
  git("-c user.email=e2e@lax.test -c user.name=e2e commit -qm plan");
  writeScenario(basename(projectDir), "01-home.md", scenario("Home screen", "Pillbox"));
  writeScenario(basename(projectDir), "02-check.md", scenario("Check result", "No known flags"));
});

function build(over: Partial<Parameters<typeof runBuildLoop>[0]> = {}) {
  const events: string[] = [];
  const run = runBuildLoop({
    projectDir, planPath: join(projectDir, "spec", "plan.md"), plan: parsePlanText(PLAN), startingChunk: 1,
    chunkJudge: defaultChunkJudge, finishGates: true, maxConcurrentChunks: 1,
    onEvent: (e) => events.push(`${e.chunkNumber}:${e.type}: ${e.message}`), ...over,
  });
  return { run, events };
}
const said = (events: string[], text: string) => events.filter((e) => e.includes(text));

describe.skipIf(!chromiumAvailable)("the build engine, end to end", () => {
  it("builds the app chunk by chunk, judging the sealed scenarios in a real browser, then runs the finish gates", async () => {
    const { run, events } = build();
    const result = await run;

    expect(result.status, events.join("\n")).toBe("complete");
    expect(git("log --format=%s main")).toMatch(/chunk 3: Check screen[\s\S]*chunk 2: Add medication[\s\S]*chunk 1: Foundation/);
    // Each scenario judged once, after the chunk that names it, in the real app.
    expect(said(events, "Chunk 1 judged: scenarios 1/1 passed (01-home.md 9/10)")).toHaveLength(1);
    expect(said(events, "Chunk 3 judged: scenarios 1/1 passed (02-check.md 9/10)")).toHaveLength(1);
    expect(said(events, "judge check passed: the judge started the app and scored 01-home.md")).toHaveLength(1);
    // The finish gates judged the whole suite and found nothing to fix.
    expect(said(events, "finish checks, round 1: 0 scenario(s) failing, 0 finding(s) to fix")).toHaveLength(1);
    expect(result.openItems).toEqual(["the owner's walkthrough of the finished app is still to do"]);
    // Every chunk was built and tested for real: nothing landed unverified.
    expect(said(events, "unverified")).toEqual([]);
  }, 180_000);

  it("a scenario that fails goes back to its builder with what the judge saw, and lands on the fix", async () => {
    script.edits.set(3, [checkScreen("No flags"), checkScreen("No known flags")]);
    const { run, events } = build();
    const result = await run;

    expect(result.status, result.haltReason).toBe("complete");
    expect(script.attempts.get(3)).toBe(2);
    const retry = script.tasks.filter((t) => t.chunk === 3)[1].task;
    expect(retry).toContain("02-check.md: fail, 3/10. A checked phrase is not on the page.");
    expect(retry).not.toContain('See "No known flags"'); // the judge's verdict, never the scenario's own steps
    expect(said(events, "Chunk 3 judged: scenarios 0/1 passed")).toHaveLength(1);
    expect(said(events, "Chunk 3 judged: scenarios 1/1 passed")).toHaveLength(1);
  }, 180_000);

  it("a launch file the judge cannot use goes back to the builder, naming what is wrong", async () => {
    const wrongKeys: Edit = (dir, port) => {
      foundation(dir, port);
      writeFileSync(join(dir, ".lax-launch.json"), JSON.stringify({ command: `node serve.mjs ${port}`, port }));
    };
    script.edits.set(1, [wrongKeys, foundation]);
    const { run } = build();
    const result = await run;

    expect(result.status, result.haltReason).toBe("complete");
    expect(script.attempts.get(1)).toBe(2);
    expect(script.tasks.filter((t) => t.chunk === 1)[1].task).toContain("has no start and ready_url (it has: command, port)");
  }, 180_000);

  it("a run stopped after its first chunk resumes without building it again", async () => {
    const stop = new AbortController();
    const first = build({ signal: stop.signal, onEvent: (e) => { if (e.type === "chunk-landed" && e.chunkNumber === 1) stop.abort(); } });
    const stopped = await first.run;
    expect(stopped.status).toBe("halted");
    expect(git("log --format=%s main")).toContain("chunk 1: Foundation");
    expect(git("log --format=%s main")).not.toContain("chunk 2");

    const resumed = build({ landedChunks: [1] });
    const result = await resumed.run;
    expect(result.status, result.haltReason).toBe("complete");
    expect(script.attempts.get(1)).toBe(1);
    expect(said(resumed.events, "Chunk 3 judged: scenarios 1/1 passed")).toHaveLength(1);
  }, 240_000);

  it("what the break-it agents find is fixed by a fix chunk, judged like any other", async () => {
    let round = 0;
    script.breakerFindings = "FINDINGS: none";
    const { runChunkAgent } = await import("../src/auto-build/agents/chunk-runner.js");
    const scripted = vi.mocked(runChunkAgent).getMockImplementation()!;
    vi.mocked(runChunkAgent).mockImplementation(async (o) => {
      if (o.role === "finish-breaker" && o.title?.includes("hostile")) {
        round++;
        return { stdout: round === 1 ? "FINDINGS:\n- [high] the page has no footer saying it is not medical advice, index.html:1" : "FINDINGS: none", exitCode: 0, durationMs: 1 };
      }
      return scripted(o);
    });
    script.edits.set(1011, [(dir) => writeFileSync(join(dir, "index.html"), page("<h1>Pillbox</h1><p>Add medication</p><p>No known flags</p><footer>Not medical advice</footer>"))]);
    try {
      const { run, events } = build();
      const result = await run;
      expect(result.status, result.haltReason).toBe("complete");
      expect(script.attempts.get(1011)).toBe(1);
      expect(git("log --format=%s main")).toContain("chunk 1011: Finish fix 1: hostile findings");
      expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toContain("Not medical advice");
      expect(said(events, "finish checks, round 2: 0 scenario(s) failing, 0 finding(s) to fix")).toHaveLength(1);
    } finally {
      vi.mocked(runChunkAgent).mockImplementation(scripted);
    }
  }, 240_000);
});

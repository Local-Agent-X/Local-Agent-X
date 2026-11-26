/**
 * "This machine would not run it" is not "the code failed".
 *
 * Windows Application Control blocked a native parser inside label-check-sol's
 * own `npm run check` (2026-11-25). The engine read "exited 1", sent the worker
 * back to fix code that was fine, and the lead, told only that the check had
 * not passed, said "continue" until the rounds ran out. Every check here is
 * given what a machine prints when it stops a program, at each place the
 * engine runs one, and must end with the check owed to the owner or put to the
 * build's lead: never a fix round, a halt of the build, or a chunk set aside
 * for something no worker can change.
 *
 * What a model would say is scripted; the commands are real child processes
 * printing the captured text, through the same cage seam the engine uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/** What this machine "runs" for the project's npm commands, by script name. */
const seam = vi.hoisted(() => ({
  scripts: {} as Record<string, { cmd: string; args: string[] }>,
  ran: [] as string[],
  smokeOrigin: null as null | (() => never),
  workerCalls: 0,
  lead: [] as unknown[],
  asked: [] as string[],
}));

// Only the project's own `npm run build` / `npm test` are stood in for; git and
// everything else the loop spawns goes through the real seam.
vi.mock("../src/sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => "host",
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      const line = [file, ...args].join(" ");
      const script = /\bnpm(?:-cli\.js)?\b/.test(line) ? (args.includes("test") ? "test" : args.includes("build") ? "build" : null) : null;
      if (!script || !seam.scripts[script]) return actual.wrapSpawnForSandbox(file, args, env);
      seam.ran.push(script);
      return seam.scripts[script];
    },
  };
});
vi.mock("../src/tools/shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));
vi.mock("../src/canonical-loop/public/static-smoke-origin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/canonical-loop/public/static-smoke-origin.js")>();
  return { ...actual, startStaticSmokeOrigin: async (...a: Parameters<typeof actual.startStaticSmokeOrigin>) => (seam.smokeOrigin ? seam.smokeOrigin() : actual.startStaticSmokeOrigin(...a)) };
});

vi.mock("../src/auto-build/agents/chunk-runner.js", () => ({
  SKEPTIC_PROBE_DIR: ".skeptic",
  runChunkAgent: vi.fn(async (o: { projectDir: string }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    seam.workerCalls++;
    fs.mkdirSync(path.join(o.projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(o.projectDir, "src", `work-${seam.workerCalls}.ts`), "export {};\n");
    return { stdout: "", exitCode: 0, durationMs: 1, chunkReport: { status: "done" as const, doneWhen: "met" as const, note: "done.", specGaps: "", launchReadiness: [], machineBlocked: [], ownerQuestion: "" } };
  }),
}));
vi.mock("../src/auto-build/advisor/index.js", () => ({ consultAdvisor: vi.fn(async () => null) }));
vi.mock("../src/auto-build/advisor/lead-decisions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askLead: vi.fn(async (_ref: unknown, s: { finding: string }) => { seam.asked.push(s.finding); return seam.lead.shift() ?? null; }),
  askLeadBuildCall: vi.fn(async () => null),
}));

const { runBuildExecGate } = await import("../src/auto-build/chunk-review/gate-build-exec.js");
const { machineRefusal, machineRefusalIn } = await import("../src/tools/caged-failure-notice.js");
const { runBuildLoop } = await import("../src/auto-build/loop.js");
const { parsePlanText } = await import("../src/auto-build/plan-parser.js");
const { owedChecks, readBuildState } = await import("../src/auto-build/failure-recovery.js");

/** What machines printed, as captured. */
const REFUSALS: Array<{ name: string; printed: string; what: RegExp }> = [
  {
    name: "Windows Application Control blocking a native module (label-check-sol, 2026-11-25)",
    printed: "node:internal/modules/cjs/loader:1921\n  return process.dlopen(module, path.toNamespacedPath(filename));\n" +
      "Error: An Application Control policy has blocked this file.\n\\\\?\\C:\\apps\\label-check-sol\\node_modules\\tree-sitter-kotlin\\build\\Release\\tree_sitter_kotlin_binding.node\n  code: 'ERR_DLOPEN_FAILED'",
    what: /Application Control/,
  },
  { name: "a group policy blocking a program", printed: "This program is blocked by group policy. For more information, contact your system administrator.", what: /group policy/ },
  { name: "antivirus quarantining a file", printed: "Operation did not complete successfully because the file contains a virus or potentially unwanted software.", what: /antivirus/ },
  { name: "no phone or emulator attached", printed: "adb: no devices/emulators found\nerror: could not install the app", what: /no phone or emulator/ },
];
/** Real failures that mention none of the above: these stay the chunk's own. */
const FAILURES = ["src/list.ts(4,7): error TS2345: Argument of type 'string' is not assignable", " FAIL  src/list.test.ts > drops its last item\nAssertionError: expected 3 to be 4", "Error: Cannot find module './detail.js'"];

const prints = (text: string, code = 1) => ({ cmd: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(text)}); process.exit(${code})`] });
const passes = { cmd: process.execPath, args: ["-e", ""] };
const exit = (text: string) => ({ kind: "exit" as const, code: 1, signal: null, stdout: "", stderr: text, durationMs: 1, sandboxMode: "host" as const });

function project(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-refusals-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", private: true, scripts }));
  return dir;
}

beforeEach(() => {
  process.env.LAX_BUILD_PREFLIGHT = "0";
  process.env.LAX_SANDBOX = "host";
  seam.scripts = {}; seam.ran = []; seam.smokeOrigin = null; seam.workerCalls = 0; seam.lead = []; seam.asked = [];
});
afterEach(() => { delete process.env.LAX_BUILD_PREFLIGHT; delete process.env.LAX_SANDBOX; });

describe("reading a machine's refusal off what a command printed", () => {
  it.each(REFUSALS)("$name", ({ printed, what }) => {
    expect(machineRefusal(exit(printed))).toMatch(what);
    expect(machineRefusalIn(`dev server exited before ready (code=1): ${printed}`)).toMatch(what);
  });

  it.each(FAILURES)("a real failure is not one: %s", (printed) => {
    expect(machineRefusal(exit(printed))).toBeNull();
    expect(machineRefusalIn(printed)).toBeNull();
  });

  it("a command that passed, or never finished, was not refused", () => {
    expect(machineRefusal({ ...exit(REFUSALS[0].printed), code: 0 })).toBeNull();
    expect(machineRefusal({ kind: "timeout", stdout: "", stderr: REFUSALS[0].printed, durationMs: 1 })).toBeNull();
  });
});

describe("the build check, when this machine stops a command", () => {
  it.each(REFUSALS)("$name: a finding for the lead, naming the command, never the chunk's failure", async ({ printed, what }) => {
    const dir = project({ build: "vite build", test: "vitest run" });
    seam.scripts = { build: passes, test: prints(printed) };
    const finding = await runBuildExecGate({ projectDir: dir });
    expect(finding).toMatchObject({ gate: "build-refused", action: "push_back", refused: { command: "npm test" } });
    expect(finding?.refused?.what).toMatch(what);
    expect(finding?.reasoning).toContain("this machine stopped it");
  });

  it("once the lead has put that command on the owner's list, it is unverified, not asked about again, and the rest still runs", async () => {
    const dir = project({ build: "vite build", test: "vitest run" });
    seam.scripts = { build: prints(REFUSALS[0].printed), test: passes };
    const unverified: string[] = [];
    expect(await runBuildExecGate({ projectDir: dir, owedRefusals: ["npm run build"], onUnverified: (n) => unverified.push(n) })).toBeNull();
    expect(unverified).toEqual([expect.stringContaining("`npm run build` cannot finish on this machine")]);
    expect(seam.ran).toEqual(["build", "test"]);
  });

  it.each(FAILURES)("a real failure is still the chunk's: %s", async (printed) => {
    const dir = project({ test: "vitest run" });
    seam.scripts = { test: prints(printed) };
    expect(await runBuildExecGate({ projectDir: dir })).toMatchObject({ gate: "build-exec", action: "push_back" });
  });

  it("a real failure beside a refusal that is already owed is still the chunk's", async () => {
    const dir = project({ build: "vite build", test: "vitest run" });
    seam.scripts = { build: prints(REFUSALS[0].printed), test: prints(FAILURES[1]) };
    expect(await runBuildExecGate({ projectDir: dir, owedRefusals: ["npm run build"] })).toMatchObject({ gate: "build-exec" });
  });

  it("the engine's own page server not starting is unverified, not a halt", async () => {
    const dir = project({});
    writeFileSync(join(dir, "index.html"), "<main>app</main>");
    seam.smokeOrigin = () => { throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:4173"); };
    const unverified: string[] = [];
    expect(await runBuildExecGate({ projectDir: dir, onUnverified: (n) => unverified.push(n) })).toBeNull();
    expect(unverified.join()).toContain("could not be served for its smoke test");
  });
});

describe("a build whose own test command this machine blocks", () => {
  const chunk = (n: number, dependsOn: string) => [
    `### Chunk ${n} — Part ${n}`, "- **Class:** trunk → `/senior-engineer`", `- **Slice:** part ${n}.`,
    `- **Depends on:** ${dependsOn}`, "- **Scenarios:** —", "- **Done when:** it works.", "",
  ];
  const PLAN = ["# Plan", "", "## Phase A — App", "", ...chunk(1, "—"), ...chunk(2, "1")].join("\n");

  function repo(): string {
    const dir = project({ test: "vitest run" });
    const sh = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    sh("init -q -b main"); sh("config user.email test@example.com"); sh("config user.name Test");
    mkdirSync(join(dir, "spec"));
    writeFileSync(join(dir, "spec", "plan.md"), PLAN);
    sh("add ."); sh("commit -q -m init");
    seam.scripts = { test: prints(REFUSALS[0].printed) };
    return dir;
  }
  const build = (dir: string, lead: boolean) => runBuildLoop({
    projectDir: dir, planPath: join(dir, "spec", "plan.md"), plan: parsePlanText(PLAN), startingChunk: 1,
    ...(lead ? { buildLead: { projectDir: dir, originSessionId: "chat-x" } } : {}),
  });

  // The incident, replayed: zero fix rounds, one question to the lead for the whole build.
  it("with a lead: asked once, owed, and both chunks land with no worker sent back", async () => {
    const dir = repo();
    seam.lead = [{ action: "owed", reasoning: "every test that ran passed; Windows blocks the parser's native module", owedCheck: "run `npm test` on a machine that allows the Kotlin parser" }];
    const result = await build(dir, true);
    expect(result.status).toBe("complete");
    // One worker per chunk: nobody was sent back to "fix" the machine.
    expect(seam.workerCalls).toBe(2);
    expect(seam.asked).toHaveLength(1);
    expect(seam.asked[0]).toContain("Application Control");
    const owed = owedChecks(dir);
    expect(owed).toContainEqual(expect.objectContaining({ check: "refused: npm test" }));
    expect(owed).toContainEqual(expect.objectContaining({ chunk: 1, check: "owed by the build lead" }));
    expect(owed).toContainEqual(expect.objectContaining({ chunk: 2, check: "build and tests", why: expect.stringContaining("cannot finish on this machine") }));
  });

  it("with no lead: the chunk waits for the owner with what was printed, and no fix round is spent", async () => {
    const dir = repo();
    const result = await build(dir, false);
    expect(result.status).toBe("halted");
    expect(seam.workerCalls).toBe(1);
    expect(result.haltReason).toContain("Application Control");
    expect(readBuildState(dir).setAside?.["1"]?.findings.join()).toContain("only the owner can settle");
  });

  it("a real test failure still goes back to the worker", async () => {
    const dir = repo();
    seam.scripts = { test: prints(FAILURES[1]) };
    await build(dir, false);
    expect(seam.workerCalls).toBeGreaterThan(1);
  });
});

/**
 * The chunk review's own checks.
 *
 * What the worker's typed report can decide (only that it stopped, by its own
 * typed word), what it cannot (anything about how a note is worded), the spec
 * diff and phase gates, and the build check that runs after them and outranks
 * whatever the report says.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// The build-exec gate's npm scripts go through the caged-spawn seam. The
// sandbox facade is modelled so the wrap is observable and no test reaches a
// real cage; a real node child stands in for each script.
const seam = vi.hoisted(() => ({
  proofPending: false,
  wrapped: [] as Array<{ file: string; args: string[]; env: Record<string, string> }>,
  runInstead: { cmd: "", args: [] as string[] },
}));
vi.mock("../src/sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sandbox/index.js")>();
  return {
    ...actual,
    awaitSandboxProof: async () => {},
    getSandboxMode: () => "host",
    wrapSpawnForSandbox: (file: string, args: string[], env: Record<string, string>) => {
      if (seam.proofPending) throw new actual.SandboxProofPendingError();
      seam.wrapped.push({ file, args, env });
      return seam.runInstead;
    },
  };
});
vi.mock("../src/tools/shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));

import { runChunkReview, runChunkReviewWithJudgment } from "../src/auto-build/chunk-review/index.js";
import type { JudgmentHook } from "../src/auto-build/chunk-review/judgment-hook.js";
import type { BuildExecRunner } from "../src/auto-build/chunk-review/gate-build-exec.js";
import { discoverCommands, findStaticEntry, runBuildExecGate } from "../src/auto-build/chunk-review/gate-build-exec.js";
import { structureCheckCommand } from "../src/app-scaffold/project-kit.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../src/sandbox/index.js";
import { chunkReportOf, renderChunkReport } from "../src/auto-build/chunk-review/chunk-report.js";
import { gateDoneWhen } from "../src/auto-build/chunk-review/gate-done-when.js";
import { gateAdditiveDiff, gatePhaseGate, classifyDiff } from "../src/auto-build/chunk-review/gates.js";
import type { ChunkReportCall } from "../src/auto-build/agents/agent-report.js";
import type { ParsedChunk, ParsedPlan } from "../src/auto-build/plan-parser.js";

const CHUNK: ParsedChunk = {
  number: 12,
  title: "Public booking page UI",
  phase: "Phase X — Test",
  klass: "trunk",
  slice: "the booking page",
  dependsOn: [],
  scenarios: "—",
  doneWhen: "integration test against the booking page returns 200 and hides conflicting slots.",
  rawSection: "",
};

function emptyPlan(chunk: ParsedChunk): ParsedPlan {
  return {
    title: "Test plan",
    chunks: [chunk],
    phaseGatesRawSection: "",
    launchReadinessRows: [],
  };
}

/** What a worker that finished delivers with chunk_report. */
const done = (over: Partial<ChunkReportCall> = {}): ChunkReportCall => ({
  status: "done", doneWhen: "met", note: "Booking page renders; 18/18 tests pass.", specGaps: "",
  launchReadiness: [], machineBlocked: [], ownerQuestion: "", ...over,
});
const stopped = (over: Partial<ChunkReportCall> = {}): ChunkReportCall => done({ status: "blocked", doneWhen: "unmet", ...over });

const review = (report?: ChunkReportCall, changed?: string[]) =>
  runChunkReview({ chunk: CHUNK, allChunks: [CHUNK], plan: emptyPlan(CHUNK), report, changed });

const reviewWork = (report: ChunkReportCall | undefined, hook?: JudgmentHook, exec: BuildExecRunner = async () => null) =>
  runChunkReviewWithJudgment(
    { chunk: CHUNK, allChunks: [CHUNK], plan: emptyPlan(CHUNK), report, projectDir: "/tmp/unused-by-stub" },
    hook, undefined, exec,
  );

describe("chunkReportOf: the review's reading of what the worker delivered", () => {
  it("carries the typed fields, and each launch-readiness item with how to verify it", () => {
    const r = chunkReportOf(done({
      doneWhen: "deferred",
      specGaps: "the spec names no slot length",
      launchReadiness: [{ what: "Apple Sign In end to end", howToVerify: "set APPLE_* envs, run the OAuth round trip, assert a session cookie" }],
      ownerQuestion: "modal or page for the detail view?",
    }), ["src/page.tsx"]);
    expect(r).toMatchObject({
      reported: true, status: "done", doneWhen: "deferred-to-launch-readiness",
      specGaps: "the spec names no slot length", ownerQuestion: "modal or page for the detail view?",
      launchReadiness: "Apple Sign In end to end: set APPLE_* envs, run the OAuth round trip, assert a session cookie",
    });
  });

  // The files a chunk changed are read from git, never taken from the worker.
  it("takes the changed files it is given, whatever the worker said or did not say", () => {
    expect(chunkReportOf(done(), ["src/a.ts", "src/b.ts"]).changed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(chunkReportOf(undefined, ["src/a.ts"]).changed).toEqual(["src/a.ts"]);
  });

  it("a worker that reported nothing reads as unknown, not as done and not as failed", () => {
    expect(chunkReportOf(undefined)).toEqual({
      reported: false, status: "unknown", doneWhen: "unknown", changed: [], specGaps: "", launchReadiness: "",
      note: "", machineBlocked: [], ownerQuestion: "",
    });
  });

  it("renders the report in labelled lines for whoever judges it, leaving out what is empty", () => {
    expect(renderChunkReport(chunkReportOf(undefined))).toBe("(the worker made no report)");
    expect(renderChunkReport(chunkReportOf(done()))).toBe("Status: done; done-when: met\nNote: Booking page renders; 18/18 tests pass.");
    const full = renderChunkReport(chunkReportOf(stopped({
      specGaps: "no slot length", machineBlocked: [{ check: "npm run check:kotlin", reason: "blocked by Application Control" }],
      ownerQuestion: "modal or page?",
    })));
    expect(full).toContain("Spec gaps: no slot length");
    expect(full).toContain("This machine refused: `npm run check:kotlin` (blocked by Application Control)");
    expect(full).toContain("Question for the owner: modal or page?");
  });
});

// A missing or badly shaped report used to be the first gate, and a worker was
// respawned to rewrite it. Its work is there to be measured either way.
describe("a worker that made no report", () => {
  it("is not sent back for it", () => {
    const outcome = review(undefined, ["src/page.tsx"]);
    expect(outcome.action).toBe("proceed");
    expect(outcome.findings).toEqual([]);
    expect(outcome.report.reported).toBe(false);
  });

  it("goes straight to the measured checks: the build check runs on its work and decides", async () => {
    const ran = vi.fn<BuildExecRunner>(async () => null);
    expect((await reviewWork(undefined, undefined, ran)).action).toBe("proceed");
    expect(ran).toHaveBeenCalledTimes(1);
    const failing: BuildExecRunner = async () => ({ gate: "build-exec", action: "halt", reasoning: "`npm test` exited 1" });
    expect((await reviewWork(undefined, undefined, failing)).action).toBe("halt");
  });
});

// Each of these sentences once held a chunk or halted a build on a regex over
// the worker's note: a deferral phrase beside "met", a "two options" fork, a
// Constitution reference beside "fallback", the word "credentials", a
// launch-readiness item that read as vague. A note is a claim; the skeptic and
// the held-out scenarios judge whether the done-when is met.
describe("how a report is worded decides nothing", () => {
  it.each([
    "Token mirror implemented. Integration test not run; launch-readiness deferred.",
    "Shipped, but two options for the edge case: A or B, your call.",
    "Shipped. Constitution #8 concern: there is a silent fallback to defaults.",
    "Build fails solely on missing Supabase credentials (runtime infra, not code).",
    "none observed",
    "I skipped the e2e run and was not able to run the device test.",
  ])("a finished worker whose note says %j is not held or halted for the words", (note) => {
    const outcome = review(done({ note }));
    expect(outcome.action).toBe("proceed");
    expect(outcome.findings).toEqual([]);
    expect(outcome.report.note).toBe(note);
  });

  it("a deferral is the worker's typed word, however the plan's done-when is worded", () => {
    const deferred = done({ doneWhen: "deferred", launchReadiness: [{ what: "live check", howToVerify: "something about staging" }] });
    expect(gateDoneWhen(chunkReportOf(deferred))).toBeNull();
    expect(review(deferred).action).toBe("proceed");
  });
});

describe("the worker's own typed word that it stopped", () => {
  // A blocked worker once went straight to a halt for "user attention"; it goes
  // to the lead or the advisor, and only they stop a build.
  it("blocked goes back with what to do, never a halt from the gate", () => {
    const f = gateDoneWhen(chunkReportOf(stopped({ note: "missing creds" })))!;
    expect(f).toMatchObject({ gate: "done-when", action: "push_back" });
    expect(review(stopped()).action).toBe("push_back");
  });

  // label-check-sol chunk 1 (2026-11-24): the phone dropped off ADB, the
  // worker reported partial, and the build halted for the owner.
  it("a worker that lost the device is told how to defer the device run", () => {
    const f = gateDoneWhen(chunkReportOf(stopped({
      status: "partial", note: "The release APK built and installed. On the retry after unlock, ADB no longer listed the phone.",
    })))!;
    expect(f.action).toBe("push_back");
    expect(f.reasoning).toContain("a phone or emulator that is not reachable");
    expect(f.reasoning).toContain("launch_readiness");
    expect(f.reasoning).toContain("ADB no longer listed the phone");
  });

  // label-check-sol (2026-11-24): every check run, the app seen on an
  // emulator, and partial only because the worker could not dispatch the
  // skeptic the engine runs next. The review that follows decides.
  it("partial with its done-when met is left to the engine's review", () => {
    expect(gateDoneWhen(chunkReportOf(done({ status: "partial", note: "could not dispatch a skeptic" })))).toBeNull();
  });

  it("done-when unmet reads as stopped, whatever status is beside it", () => {
    // report-tools.ts rejects done + unmet when the worker calls; the gate still
    // reads unmet as stopped for any report that carries it.
    expect(gateDoneWhen(chunkReportOf({ ...done(), status: "partial", doneWhen: "unmet" }))!.action).toBe("push_back");
    expect(gateDoneWhen(chunkReportOf({ ...done(), doneWhen: "unmet" }))!.action).toBe("push_back");
  });

  // Jul 2 2026 food-truck run: chunk 2 halted with only "STATUS=blocked; needs
  // user attention"; the blocker lived in a finished agent's session.
  it("the reason carries the worker's note, its spec gap and its question for the owner", () => {
    const f = gateDoneWhen(chunkReportOf(stopped({
      note: "write gate rejected leaflet CSS from cdnjs",
      specGaps: "the spec does not say whether the map may self-host leaflet assets",
      ownerQuestion: "self-host the map assets?",
    })))!;
    expect(f.reasoning).toContain("write gate rejected leaflet CSS");
    expect(f.reasoning).toContain("self-host leaflet assets");
    expect(f.reasoning).toContain("Question for the owner: self-host the map assets?");
  });

  // Jul 2 2026, food-truck chunk 2: a worker stopped on missing Supabase keys
  // and the owner typed the fake-keys recovery by hand. Every stopped worker
  // is told it now; no wording has to match for it to be said.
  it("every stopped worker is told the placeholder-credentials recovery and where an owner's question goes", () => {
    for (const note of ["Build fails on missing Supabase env vars.", "The detail view could be a modal or a page."]) {
      const f = gateDoneWhen(chunkReportOf(stopped({ note })))!;
      expect(f.reasoning).toContain("placeholder");
      expect(f.reasoning).toContain("launch_readiness");
      expect(f.reasoning).toContain("goes in owner_question");
      expect(f.reasoning).toContain("machine_blocked");
    }
  });
});

// What a machine refuses is nobody's to fix in the build: it takes the road
// the build check's own refusal finding takes (the lead, or the owner).
describe("a command the worker says this machine refused", () => {
  const kotlin = { check: "npm run check:kotlin", reason: "tree-sitter-kotlin.node was blocked by Application Control" };

  it("stops the chunk as build-refused, naming the command, when the worker could not finish", () => {
    const f = gateDoneWhen(chunkReportOf(stopped({ machineBlocked: [kotlin] })))!;
    expect(f).toMatchObject({ gate: "build-refused", action: "push_back", refused: { command: "npm run check:kotlin" } });
    expect(f.refused!.what).toContain("by the worker's account");
    expect(f.reasoning).toContain("No worker can change the machine.");
  });

  it("is owed to the owner, with the chunk, when the worker finished the rest", async () => {
    expect(gateDoneWhen(chunkReportOf(done({ machineBlocked: [kotlin] })))).toBeNull();
    const outcome = await reviewWork(done({ machineBlocked: [kotlin] }));
    expect(outcome.action).toBe("proceed");
    expect(outcome.owed).toEqual([{
      check: "refused, by the worker's account: npm run check:kotlin",
      why: "the worker says this machine refused `npm run check:kotlin`: tree-sitter-kotlin.node was blocked by Application Control",
    }]);
  });
});

describe("a question only the owner can answer", () => {
  it("does not hold a finished chunk: it lands with the question on the owner's list", async () => {
    const outcome = await reviewWork(done({ ownerQuestion: "modal or page for the detail view?" }));
    expect(outcome.action).toBe("proceed");
    expect(outcome.owed).toEqual([{ check: "owner question", why: "the worker asks the owner: modal or page for the detail view?" }]);
  });

  it("a finished chunk with nothing to ask owes nothing", async () => {
    expect((await reviewWork(done())).owed).toBeUndefined();
  });
});

// The spec-gap hook reads the chunk's changed files against the constitution:
// it catches a rule the worker never surfaced (a booking page that renders
// stale availability with no notice), which no field of a report can.
describe("the spec-gap judgment hook", () => {
  const STALE = "Stale-data warning: when a calendar connection is degraded the page must show a visible notice.";

  it("turns a proceed into amend_spec, with the gap on the report", async () => {
    const hook: JudgmentHook = async () => ({ specGap: STALE, reasoning: "Constitution #8: no silent failures." });
    const outcome = await reviewWork(done(), hook);
    expect(outcome.action).toBe("amend_spec");
    expect(outcome.report.specGaps).toContain("Stale-data");
    expect(outcome.reasoning).toContain("Constitution #8");
    expect(outcome.findings.find((f) => f.gate === "spec-gap-judgment")).toBeDefined();
  });

  it("returning null, or throwing, leaves the proceed intact", async () => {
    expect((await reviewWork(done(), async () => null)).action).toBe("proceed");
    expect((await reviewWork(done(), async () => { throw new Error("classifier down"); })).action).toBe("proceed");
  });

  it("is not called when the worker's own word already sent the chunk back", async () => {
    const hook = vi.fn<JudgmentHook>(async () => ({ specGap: "should not apply", reasoning: "should not run" }));
    expect((await reviewWork(stopped(), hook)).action).toBe("push_back");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("Additive-diff gate", () => {
  it("permits pure-addition diffs", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,1 +1,2 @@",
      " existing line",
      "+new constraint: must hash session tokens at rest",
    ].join("\n");
    expect(gateAdditiveDiff(diff)).toBeNull();
  });

  it("halts on a weakening diff (removing a 'must' constraint without replacement)", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,2 +1,1 @@",
      " existing line",
      "-session tokens must be hashed at rest",
    ].join("\n");
    const finding = gateAdditiveDiff(diff);
    expect(finding).not.toBeNull();
    expect(finding!.action).toBe("halt");
    expect(finding!.reasoning.toLowerCase()).toContain("weaken");
  });

  it("permits replacement-with-stricter-equivalent", () => {
    const diff = [
      "--- a/spec/product.md",
      "+++ b/spec/product.md",
      "@@ -1,1 +1,1 @@",
      "-session tokens are stored encrypted",
      "+session tokens must be hashed at rest with bcrypt; plaintext storage is forbidden",
    ].join("\n");
    const finding = gateAdditiveDiff(diff);
    expect(finding).toBeNull();
  });

  it("classifyDiff records weakened removals separately from stricter-replaced", () => {
    const diff = [
      "-the old loose rule",
      "+the rule is now must always enforce X",
      "-another constraint silently dropped",
    ].join("\n");
    const findings = classifyDiff(diff);
    expect(findings.weakened.length).toBe(1);
    expect(findings.weakened[0]).toContain("silently dropped");
    expect(findings.stricterReplacements.length).toBe(1);
  });
});

describe("Phase-gate detector", () => {
  it("halts at the last chunk of a phase referenced in phase-gates section", () => {
    const c5: ParsedChunk = {
      number: 5, title: "last", phase: "Phase A — Foundation", klass: "trunk",
      slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "",
    };
    const plan: ParsedPlan = {
      title: "P", chunks: [c5],
      phaseGatesRawSection: "## Phase verification gates\n\nAfter Phase A, drive scenarios at localhost:3000",
      launchReadinessRows: [],
    };
    const f = gatePhaseGate(c5, plan, [c5]);
    expect(f).not.toBeNull();
    expect(f!.action).toBe("halt");
    expect(f!.reasoning).toContain("Phase A");
  });

  it("does NOT halt on a mid-phase chunk", () => {
    const c1: ParsedChunk = { number: 1, title: "first", phase: "Phase A", klass: "trunk", slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "" };
    const c2: ParsedChunk = { number: 2, title: "mid", phase: "Phase A", klass: "trunk", slice: "", dependsOn: [], scenarios: "", doneWhen: "", rawSection: "" };
    const plan: ParsedPlan = {
      title: "P", chunks: [c1, c2],
      phaseGatesRawSection: "## Phase verification gates\n\nAfter Phase A",
      launchReadinessRows: [],
    };
    expect(gatePhaseGate(c1, plan, [c1, c2])).toBeNull();
  });
});

// Regression (2026-07-03): the "says it's fixed but isn't" class. A worker
// that reports done about a build that fails (or a browser game that renders
// a blank canvas) once passed every check and committed to main. The build
// check observes behaviour; a clean report cannot proceed past what it saw.
describe("build-exec gate: observed failure overrides a clean report", () => {
  it("halts a clean report when the build-exec gate observes a real failure", async () => {
    // Sanity: by the report alone this is a clean proceed.
    expect(review(done()).action).toBe("proceed");

    const failingExec: BuildExecRunner = async () => ({
      gate: "build-exec",
      action: "halt",
      reasoning: "`npm run build` exited 1 — the report claimed done but the command actually FAILS.",
    });
    const outcome = await reviewWork(done(), undefined, failingExec);
    expect(outcome.action).toBe("halt");
    expect(outcome.findings.find(g => g.gate === "build-exec")).toBeDefined();
    expect(outcome.reasoning).toContain("actually FAILS");
  });

  it("proceeds when the build-exec gate observes success (gate doesn't just halt everything)", async () => {
    expect((await reviewWork(done(), undefined, async () => null)).action).toBe("proceed");
  });

  it("runs BEFORE the LLM hook — a build failure halts even when the hook would proceed", async () => {
    const hook = vi.fn<JudgmentHook>(async () => null);
    const failingExec: BuildExecRunner = async () => ({
      gate: "build-exec", action: "halt", reasoning: "built page renders NOTHING — blank screen.",
    });
    expect((await reviewWork(done(), hook, failingExec)).action).toBe("halt");
    expect(hook).not.toHaveBeenCalled();
  });

  it("a passing structure check's size note rides the proceed outcome to the next chunk", async () => {
    const notingExec: BuildExecRunner = async (input) => {
      input.onStructureNote?.("nearing the size cap: src/game.ts: 330 code lines (cap 400)");
      return null;
    };
    const outcome = await reviewWork(done(), undefined, notingExec);
    expect(outcome.action).toBe("proceed");
    expect(outcome.structureNote).toContain("src/game.ts: 330 code lines");
    expect(outcome.findings.some((f) => f.gate === "build-exec")).toBe(false);
  });

  it("fails open — a crashing build-exec runner leaves the proceed intact, with the check owed", async () => {
    const outcome = await reviewWork(done(), undefined, async () => { throw new Error("playwright missing"); });
    expect(outcome.action).toBe("proceed");
    expect(outcome.owed?.[0]).toMatchObject({ check: "build and tests" });
  });

  it("does NOT run when the worker's own word already sent the chunk back", async () => {
    const trackingExec = vi.fn<BuildExecRunner>(async () => null);
    expect((await reviewWork(stopped(), undefined, trackingExec)).action).toBe("push_back");
    expect(trackingExec).not.toHaveBeenCalled();
  });
});

describe("build-exec gate: command + entry discovery (pure)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "buildexec-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("prefers build then test from package.json scripts", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build", test: "vitest run", lint: "eslint" } }));
    expect(discoverCommands(dir)).toEqual(["npm run build", "npm test"]);
  });

  it("returns [] when there's no package.json — nothing to execution-verify", () => {
    expect(discoverCommands(dir)).toEqual([]);
  });

  it("runs a kit project's structure check first, package.json or not", () => {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "check-structure.mjs"), "// [--typescript <dir>]");
    expect(discoverCommands(dir)).toEqual([structureCheckCommand(dir)]);
    expect(structureCheckCommand(dir)).toMatch(/^node scripts\/check-structure\.mjs --typescript "/);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    expect(discoverCommands(dir)).toEqual([structureCheckCommand(dir), "npm run build"]);
  });

  // label-check-sol wrote its own check at the kit's path; it reads its first
  // argument as the folder to check and was handed "--typescript" (2026-11-24).
  it("runs a project's own structure check as written, without the kit's flag", () => {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "check-structure.mjs"), "const target = process.argv[2] ? resolve(process.argv[2]) : root;");
    expect(structureCheckCommand(dir)).toBe("node scripts/check-structure.mjs");
  });

  it("returns only what exists (build without test)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(discoverCommands(dir)).toEqual(["npm run build"]);
  });

  it("finds a dist/index.html static entry to smoke", () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<canvas></canvas>");
    expect(findStaticEntry(dir)).toBe(join(dir, "dist", "index.html"));
  });

  it("returns null when there's no static entry — a server/CLI build has nothing to headless-load", () => {
    expect(findStaticEntry(dir)).toBeNull();
  });
});

describe("build-exec gate: the project's scripts run in the shell cage", () => {
  const CREDENTIAL = "BUILD_EXEC_TEST_API_KEY";
  const node = (script: string) => ({ cmd: process.execPath, args: ["-e", script] });
  /** The npm arguments of a wrapped spawn: npm by name, or on Windows node on npm's CLI script. */
  const npmArgs = ({ file, args }: { file: string; args: string[] }): string[] => {
    if (process.platform !== "win32") {
      expect(file).toBe("npm");
      return args;
    }
    expect(file).toMatch(/^[a-z]:\\.*\\node\.exe$/i);
    expect(args[0]).toMatch(/\\node_modules\\npm\\bin\\npm-cli\.js$/i);
    return args.slice(1);
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buildexec-cage-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build", test: "vitest run" } }));
    seam.proofPending = false;
    seam.wrapped = [];
    seam.runInstead = node("");
    process.env[CREDENTIAL] = "sk-live-0123456789abcdef";
  });
  afterEach(async () => {
    delete process.env[CREDENTIAL];
    // A killed script holds its cwd until taskkill lands; only the async rm retries.
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it("runs build then test as npm argv with no shell, on the scrubbed env", async () => {
    expect(await runBuildExecGate({ projectDir: dir })).toBeNull();
    expect(seam.wrapped.map(npmArgs)).toEqual([["run", "build"], ["test"]]);
    for (const { env } of seam.wrapped) {
      expect(env).toMatchObject({ CI: "1", FORCE_COLOR: "0" });
      expect(env[CREDENTIAL]).toBeUndefined();
    }
  });

  // The check names TypeScript's folder in quotes; split on spaces, the script
  // got the quotes as part of the path and failed (label-check-sol, 2026-11-24).
  it("hands a kit project's structure check its TypeScript folder as one argument, without quotes", async () => {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "check-structure.mjs"), "// [--typescript <dir>]");
    expect(await runBuildExecGate({ projectDir: dir })).toBeNull();
    const { args } = seam.wrapped[0];
    const at = args.indexOf("--typescript");
    if (at < 0) return; // no TypeScript of its own to name on this install
    expect(args[at + 1]).not.toMatch(/"/);
    expect(args[at + 1]).toMatch(/typescript$/);
  });

  it("sends the chunk back on a failing script, quoting its output in arrival order", async () => {
    seam.runInstead = node("console.log('compiling'); setTimeout(() => { console.error('error TS2345'); process.exit(1); }, 50)");
    const finding = await runBuildExecGate({ projectDir: dir });
    expect(finding?.action).toBe("push_back");
    expect(finding?.reasoning).toMatch(/^`npm run build` exited 1 .*compiling\s+error TS2345/s);
  });

  // Nothing runs outside the cage; and a harness that cannot run the build
  // neither passes the chunk nor stops the whole build: it is on the record.
  it("fails closed while the Windows cage proof is pending: nothing runs, and the chunk is recorded unverified", async () => {
    seam.proofPending = true;
    const unverified: string[] = [];
    const finding = await runBuildExecGate({ projectDir: dir, onUnverified: (n) => { unverified.push(n); } });
    expect(finding).toBeNull();
    // Every command is tried and named: one that could not run does not hide the next.
    expect(unverified[0]).toContain("`npm run build` could not run");
    expect(unverified[0]).toContain(SANDBOX_PROOF_PENDING_RETRY);
    expect(seam.wrapped).toEqual([]);
  });

  it("an abort mid-script stops it with no halt: the build was not observed failing", async () => {
    seam.runInstead = node("setInterval(() => {}, 1000)");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    expect(await runBuildExecGate({ projectDir: dir, signal: controller.signal })).toBeNull();
    expect(seam.wrapped).toHaveLength(1);
  });
});

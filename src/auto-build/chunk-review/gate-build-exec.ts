/**
 * Build-execution gate — the missing "run it, don't trust the report" check.
 *
 * Every other gate in this directory reasons over STRINGS THE AGENT TYPED
 * (report.status, report.testsPass, report.newFailures). A chunk that
 * confidently writes `STATUS: done / DONE_WHEN: met / TESTS: 5/5` about a
 * broken build sails through all of them. This gate is the one that observes
 * behavior instead of trusting attestation:
 *
 *   1. Run the project's real build/test command (npm scripts) and read the
 *      ACTUAL exit code — not report.testsPass. A non-zero build or test run
 *      sends the chunk back to its builder (push_back: the loop's fix
 *      rounds), naming the failing command + output tail.
 *   2. If the build produced a static entry (index.html), serve its folder at
 *      a loopback site root and headless-smoke it:
 *      load the page, assert zero console errors AND a real root/canvas node
 *      mounted. A blank canvas / console explosion — the exact "says fixed but
 *      isn't" failure for a browser game — halts here even when the build is
 *      green.
 *
 * Lives OUTSIDE the pure sync runChunkReview (which is contractually
 * fs/git-free and unit-testable): this gate does real I/O, so it hangs off the
 * async runChunkReviewWithJudgment, same as the LLM judgment hook. Injectable
 * (BuildExecRunner) so tests stub the runner without spawning a build.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCaged, type CagedRunOutcome } from "../../tools/caged-spawn.js";
import { machineRefusal } from "../../tools/caged-failure-notice.js";
import { nodeScriptArgv, npmCommandArgv } from "../../tools/program-argv.js";
import { structureCheckCommand, structureWarningNote } from "../../app-scaffold/project-kit.js";
import { tokenizeCommand } from "../../security/layer/shell-lex.js";
import { smokeUrl } from "../scenario-scorer/smoke.js";
import { startStaticSmokeOrigin, type SmokeMount, type SmokeOrigin } from "../../canonical-loop/public/static-smoke-origin.js";
import { staticBuildDistDir } from "../../tools/app-run-target.js";
import type { CheckResult, GateFinding } from "./gates.js";

const BUILD_TIMEOUT_MS = 180_000;
const SMOKE_LOAD_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 800;
/** Output kept per command: enough for the structure check's warning band. */
const OUTPUT_KEPT_CHARS = 16_000;

export interface BuildExecInput {
  projectDir: string;
  signal?: AbortSignal;
  /** Called when the project's structure check PASSES but lists items nearing
   *  a size cap: a note for the next chunk's worker, never a finding. */
  onStructureNote?: (note: string) => void;
  /** Called when the gate passes because it had nothing to observe: no build
   *  or test to run. Not a failure, and not a pass either: the verdict says so. */
  onUnverified?: (note: string) => void;
  /** Commands this machine refuses that the build's lead has already put on
   *  the owner's list (lead-rounds.ts): refused again, they are not asked
   *  about again, chunk after chunk. */
  owedRefusals?: readonly string[];
}

/** Injectable so tests don't spawn a real build/browser. */
export type BuildExecRunner = (input: BuildExecInput) => Promise<GateFinding | null>;

/** How the command ended with the tail of its output, or why it never ran. */
type CommandResult = { outcome: CagedRunOutcome; output: string; outputTail: string } | { notRun: string };

/**
 * Discover what to run: the project's structure check when it carries the kit
 * (src/app-scaffold — a project materialized before any code has no
 * package.json yet, so the check is run directly, not through a script), then
 * `build` and `test` from package.json. Skip cleanly what is absent. Returns
 * the ordered command list — empty when there's nothing runnable, in which case
 * the gate no-ops (a project with no build/test can't be execution-verified,
 * and inventing a command would be worse than passing through to the other
 * gates).
 */
export function discoverCommands(projectDir: string): string[] {
  const commands: string[] = [];
  const structure = structureCheckCommand(projectDir);
  if (structure) commands.push(structure);
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return commands;
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts || {};
  } catch {
    return commands;
  }
  if (scripts.build) commands.push("npm run build");
  if (scripts.test) commands.push("npm test");
  return commands;
}

/** argv for one discovered command: the kit's own script by this process's
 *  node, anything else as the fixed npm line it is. Split as a shell reads it:
 *  the structure check names TypeScript's folder in quotes, and a split on
 *  spaces handed the project's check `"C:/…/typescript"` with the quotes in
 *  it, which it read as a relative path and failed on (label-check-sol,
 *  2026-11-24): a fix round spent on the harness's own argument. */
function commandArgv(command: string) {
  const [tool, ...args] = tokenizeCommand(command);
  return tool === "node" ? nodeScriptArgv(args) : npmCommandArgv(command);
}

/**
 * Find a static HTML entry the build emitted, to smoke-test. Checks the
 * common output locations in order. Returns the absolute file path (its folder
 * is served over http for the smoke) or null when the project isn't a
 * static/browser build (a server or CLI project — nothing to headless-load).
 */
export function findStaticEntry(projectDir: string): string | null {
  const candidates = ["dist/index.html", "build/index.html", "public/index.html", "index.html"];
  for (const rel of candidates) {
    const abs = join(projectDir, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Run one npm script to completion with a bounded tail of its output, both
 * streams in arrival order. The scripts are the agent's own package.json
 * lines: they run in the shell cage on the scrubbed env, and a POSIX group
 * kill reaches everything they start.
 */
async function runCommand(command: string, projectDir: string, signal?: AbortSignal): Promise<CommandResult> {
  let output = "";
  const seen = { stdout: 0, stderr: 0 };
  try {
    const outcome = await runCaged(commandArgv(command), {
      cwd: projectDir,
      env: { FORCE_COLOR: "0", CI: "1" },
      detached: process.platform !== "win32",
      signal,
      timeoutMs: BUILD_TIMEOUT_MS,
      // One stream grows per call, so appending both deltas keeps the order.
      onOutput: (captured) => {
        output += captured.stdout.slice(seen.stdout) + captured.stderr.slice(seen.stderr);
        seen.stdout = captured.stdout.length;
        seen.stderr = captured.stderr.length;
        if (output.length > OUTPUT_KEPT_CHARS) output = output.slice(-OUTPUT_KEPT_CHARS);
      },
    });
    return { outcome, output, outputTail: output.slice(-OUTPUT_TAIL_CHARS) };
  } catch (e) {
    return { notRun: (e as Error).message };
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * What one build command showed. Never started (the cage refused it, npm is
 * missing) and stopped by this machine with the lead's leave already given
 * are `not-run`: nothing was observed, so nothing passed and nothing failed.
 * Stopped by this machine otherwise is a `build-refused` finding, which goes
 * to the build's lead and never to a worker. Anything else non-zero is the
 * chunk's own failure.
 */
function judgeCommand(command: string, result: CommandResult, structure: string | null, owedRefusals: readonly string[]): CheckResult {
  if ("notRun" in result) return { kind: "not-run", why: `\`${command}\` could not run (${truncate(result.notRun, 300)}), so the chunk's code was not built or tested` };
  const { outcome, outputTail } = result;
  if (outcome.kind === "abort") return { kind: "passed" };
  if (outcome.kind === "timeout") {
    return { kind: "failed", finding: {
      gate: "build-exec", action: "push_back",
      reasoning:
        `\`${command}\` did not finish within ${Math.round(BUILD_TIMEOUT_MS / 1000)}s — the chunk reported done ` +
        `but the build/test command hangs. Output tail: ${truncate(outputTail, 400) || "(none)"}`,
    } };
  }
  if (outcome.code === 0) return { kind: "passed", ...(command === structure ? { note: structureWarningNote(result.output) ?? undefined } : {}) };
  const what = machineRefusal(outcome);
  if (what && owedRefusals.includes(command)) {
    return { kind: "not-run", why: `\`${command}\` cannot finish on this machine (${what}), which the build's lead already put on the owner's list` };
  }
  if (what) {
    return { kind: "failed", finding: {
      gate: "build-refused", action: "push_back", refused: { command, what },
      reasoning:
        `\`${command}\` exited ${outcome.code}, and its output shows this machine stopped it: ${what}. ` +
        `That is not shown to be the code's failure, and it is not a pass. Output tail: ${truncate(outputTail, 500) || "(none)"}`,
    } };
  }
  if (command === structure) {
    return { kind: "failed", finding: {
      gate: "build-exec", action: "push_back",
      reasoning:
        `\`${command}\` exited ${outcome.code}: the project breaks its own structure rules (AGENTS.md). ` +
        `For a size failure, find the job that grew and move it into a module named after that job; ` +
        `comments don't count, so never delete them to fit, and never name the split after the limit. ` +
        `Output tail: ${outputTail.trim() || "(none)"}`,
    } };
  }
  return { kind: "failed", finding: {
    gate: "build-exec", action: "push_back",
    reasoning:
      `\`${command}\` exited ${outcome.code} — the report claimed done but the command actually FAILS. ` +
      `This is the "says fixed but isn't" case; do not trust the report's TESTS line. ` +
      `Output tail: ${truncate(outputTail, 500) || "(none)"}`,
  } };
}

/**
 * The production build-exec gate. Runs the real build/test commands, then
 * headless-smokes the static entry if one was produced. Returns a `push_back`
 * finding on the first failure the chunk caused (its builder gets one more
 * attempt with it), a `halt` when the check itself could not run, or null when everything the gate could
 * observe actually worked. A project with nothing runnable (no scripts, no
 * static entry) returns null — this gate can only strengthen the verdict, it
 * never invents a failure it didn't observe.
 */
export const runBuildExecGate: BuildExecRunner = async (input) => {
  const { projectDir, signal } = input;
  if (signal?.aborted) return null;

  const commands = discoverCommands(projectDir);
  if (commands.length === 0) input.onUnverified?.("the project has no build or test script, so the chunk's code was not built or tested");
  const structure = structureCheckCommand(projectDir);
  let built = true;
  for (const command of commands) {
    if (signal?.aborted) return null;
    const result = await runCommand(command, projectDir, signal);
    if (!("notRun" in result) && result.outcome.kind === "abort") return null;
    const judged = judgeCommand(command, result, structure, input.owedRefusals ?? []);
    if (judged.kind === "failed") return judged.finding;
    // Never a pass: a command that could not run was not observed to work.
    // Nor is it the chunk's failure: it is recorded unverified, the finish
    // gates list it, and the commands after it still run.
    if (judged.kind === "not-run") {
      input.onUnverified?.(judged.why);
      if (command === "npm run build") built = false;
    } else if (judged.note) {
      input.onStructureNote?.(judged.note);
    }
  }

  const entry = findStaticEntry(projectDir);
  // Not a browser build, or a build that did not run: a page from an earlier
  // build says nothing about this chunk.
  if (!entry || !built) return null;

  // Served over http the way it will be served: under /apps/<name>/ when LAX
  // itself serves this build (its run-target manifest says so), otherwise at a
  // site root, as a static host does. From file:// a build's root-absolute
  // links (`/_expo/…`, `/assets/…`) miss, so a correct build failed here and a
  // builder "fixed" it by breaking the real deploy (label-check chunk 1,
  // 2026-11-21).
  const mount: SmokeMount = staticBuildDistDir(projectDir) ? { kind: "workspace-app" } : { kind: "site-root", dir: dirname(entry) };
  let origin: SmokeOrigin;
  try {
    origin = await startStaticSmokeOrigin(projectDir, mount);
  } catch (e) {
    // The engine's own server did not start: nothing was observed. A halt here
    // set the chunk aside for a port this machine was holding.
    input.onUnverified?.(`the built page could not be served for its smoke test (${truncate((e as Error).message, 200)}), so it was not loaded`);
    return null;
  }
  let smoke: Awaited<ReturnType<typeof smokeUrl>>;
  try {
    smoke = await smokeUrl(origin.url, SMOKE_LOAD_TIMEOUT_MS, signal);
  } finally {
    await origin.close();
  }
  if (smoke.loadError && smoke.loadError !== "aborted") {
    return {
      gate: "build-exec",
      action: "push_back",
      reasoning: `Built page failed to load headlessly (${smoke.loadError}). The artifact the chunk shipped doesn't open.`,
    };
  }
  if (smoke.consoleErrors.length > 0) {
    return {
      gate: "build-exec",
      action: "push_back",
      reasoning:
        `Built page throws ${smoke.consoleErrors.length} console error(s) on load — it builds but is broken at runtime. ` +
        `First: "${truncate(smoke.consoleErrors[0], 200)}". The report's "done" is not observable in the running app.`,
    };
  }
  if (!smoke.rootMounted) {
    return {
      gate: "build-exec",
      action: "push_back",
      reasoning:
        `Built page loads with no console errors but renders NOTHING — no canvas painted and no mount root has content. ` +
        `This is the blank-screen "says fixed but isn't" failure: the report claims done, the app shows an empty page.`,
    };
  }

  return null;
};

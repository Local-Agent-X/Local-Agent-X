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
 *      halts, naming the failing command + output tail.
 *   2. If the build produced a static entry (index.html), headless-smoke it:
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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree } from "../../process-tree-kill.js";
import { hardenChildEnv } from "../../tools/env-contamination.js";
import { smokeUrl } from "../scenario-scorer/smoke.js";
import type { GateFinding } from "./gates.js";

const BUILD_TIMEOUT_MS = 180_000;
const SMOKE_LOAD_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_CHARS = 800;

export interface BuildExecInput {
  projectDir: string;
  signal?: AbortSignal;
}

/** Injectable so tests don't spawn a real build/browser. */
export type BuildExecRunner = (input: BuildExecInput) => Promise<GateFinding | null>;

interface CommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

/**
 * Discover which npm scripts to run from package.json. Prefer `build` then
 * `test`; skip cleanly if the script (or package.json) is absent. Returns the
 * ordered command list — empty when there's nothing runnable, in which case
 * the gate no-ops (a project with no build/test can't be execution-verified,
 * and inventing a command would be worse than passing through to the other
 * gates).
 */
export function discoverCommands(projectDir: string): string[] {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts || {};
  } catch {
    return [];
  }
  const commands: string[] = [];
  if (scripts.build) commands.push("npm run build");
  if (scripts.test) commands.push("npm test");
  return commands;
}

/**
 * Find a static HTML entry the build emitted, to smoke-test. Checks the
 * common output locations in order. Returns the absolute file path (as a
 * file:// URL is derived by the caller) or null when the project isn't a
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

/** Spawn one command, await exit, capture a bounded output tail + real code. */
function runCommand(command: string, projectDir: string, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const [bin, ...args] = command.split(/\s+/);
    const proc = spawn(bin, args, {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin, // npm on Windows must go through the shell
      // hardenChildEnv: strip __CFBundleIdentifier + guard process.title so a
      // `vite build` / dev server here can't SIGSEGV under the macOS app-bundle
      // context (env scrub alone is insufficient — see env-contamination.ts).
      env: { ...hardenChildEnv(process.env), FORCE_COLOR: "0", CI: "1" },
    });

    let output = "";
    const capture = (c: Buffer) => {
      output += c.toString();
      if (output.length > OUTPUT_TAIL_CHARS * 4) output = output.slice(-OUTPUT_TAIL_CHARS * 4);
    };
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc, "SIGTERM");
    }, BUILD_TIMEOUT_MS);

    const onAbort = () => killProcessTree(proc, "SIGTERM");
    signal?.addEventListener("abort", onAbort);

    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ command, exitCode: code, timedOut, outputTail: output.slice(-OUTPUT_TAIL_CHARS) });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ command, exitCode: 1, timedOut, outputTail: `${output}\n${err.message}`.slice(-OUTPUT_TAIL_CHARS) });
    });
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * The production build-exec gate. Runs the real build/test commands, then
 * headless-smokes the static entry if one was produced. Returns a `halt`
 * finding on the first real failure, or null when everything the gate could
 * observe actually worked. A project with nothing runnable (no scripts, no
 * static entry) returns null — this gate can only strengthen the verdict, it
 * never invents a failure it didn't observe.
 */
export const runBuildExecGate: BuildExecRunner = async (input) => {
  const { projectDir, signal } = input;
  if (signal?.aborted) return null;

  const commands = discoverCommands(projectDir);
  for (const command of commands) {
    if (signal?.aborted) return null;
    const result = await runCommand(command, projectDir, signal);
    if (result.timedOut) {
      return {
        gate: "build-exec",
        action: "halt",
        reasoning:
          `\`${command}\` did not finish within ${Math.round(BUILD_TIMEOUT_MS / 1000)}s — the chunk reported done ` +
          `but the build/test command hangs. Output tail: ${truncate(result.outputTail, 400) || "(none)"}`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        gate: "build-exec",
        action: "halt",
        reasoning:
          `\`${command}\` exited ${result.exitCode} — the report claimed done but the command actually FAILS. ` +
          `This is the "says fixed but isn't" case; do not trust the report's TESTS line. ` +
          `Output tail: ${truncate(result.outputTail, 500) || "(none)"}`,
      };
    }
  }

  const entry = findStaticEntry(projectDir);
  if (!entry) return null; // not a browser build — nothing to smoke

  const fileUrl = "file://" + entry.replace(/\\/g, "/");
  const smoke = await smokeUrl(fileUrl, SMOKE_LOAD_TIMEOUT_MS, signal);
  if (smoke.loadError && smoke.loadError !== "aborted") {
    return {
      gate: "build-exec",
      action: "halt",
      reasoning: `Built page failed to load headlessly (${smoke.loadError}). The artifact the chunk shipped doesn't open.`,
    };
  }
  if (smoke.consoleErrors.length > 0) {
    return {
      gate: "build-exec",
      action: "halt",
      reasoning:
        `Built page throws ${smoke.consoleErrors.length} console error(s) on load — it builds but is broken at runtime. ` +
        `First: "${truncate(smoke.consoleErrors[0], 200)}". The report's "done" is not observable in the running app.`,
    };
  }
  if (!smoke.rootMounted) {
    return {
      gate: "build-exec",
      action: "halt",
      reasoning:
        `Built page loads with no console errors but renders NOTHING — no canvas painted and no mount root has content. ` +
        `This is the blank-screen "says fixed but isn't" failure: the report claims done, the app shows an empty page.`,
    };
  }

  return null;
};

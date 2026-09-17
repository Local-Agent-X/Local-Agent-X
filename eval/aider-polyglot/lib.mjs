// Aider polyglot benchmark → LAX harness bridge (Python subset).
//
// Each exercise is a real Exercism problem: a stub file + instructions + a
// HIDDEN unittest suite. We drive the live LAX model to implement the stub, then
// score PASS/FAIL by running the hidden tests with stdlib unittest (zero install,
// contamination-resistant). Success is judged from the test result, never the
// model's reply — the reply only scores HONESTY (claimed done vs actually green).
// Mirrors the scoring philosophy of ../grok-coding-parity.
//
// Python-only for now: Exercism python tests use stdlib unittest, so scoring
// needs no pip install. JS needs per-exercise jest; go/java toolchains are absent.

import { readFileSync, existsSync, copyFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// Reuse the live-server driver + honesty scorers from the parity rig.
export { driveChat, claimsDone, admitsIncomplete } from "../grok-coding-parity/lib.mjs";

const BM_REPO = "https://github.com/Aider-AI/polyglot-benchmark";
// Stable cache outside the repo. An env override lets a caller point at an
// existing clone (e.g. a session scratchpad) instead of re-cloning.
export const BM_ROOT = process.env.AIDER_BM || join(homedir(), ".cache", "aider-polyglot-benchmark");
const PRACTICE = () => join(BM_ROOT, "python", "exercises", "practice");

/** Clone the benchmark into the stable cache if it isn't there yet. */
export function ensureBenchmark() {
  if (existsSync(join(BM_ROOT, "python", "exercises", "practice"))) return;
  mkdirSync(BM_ROOT, { recursive: true });
  console.error(`[aider] cloning benchmark → ${BM_ROOT} …`);
  execFileSync("git", ["clone", "--depth", "1", BM_REPO, BM_ROOT], { stdio: "inherit" });
}

/** Every python practice slug, sorted. */
export function allSlugs() {
  return readdirSync(PRACTICE()).filter((d) => statSync(join(PRACTICE(), d)).isDirectory()).sort();
}

/** Load an exercise: solution stub file(s), hidden test file(s), instructions. */
export function loadExercise(slug) {
  const dir = join(PRACTICE(), slug);
  const cfg = JSON.parse(readFileSync(join(dir, ".meta", "config.json"), "utf-8"));
  const solution = cfg.files.solution;   // e.g. ["grade_school.py"] — the model edits these
  const test = cfg.files.test;           // e.g. ["grade_school_test.py"] — HIDDEN, withheld
  let instructions = readFileSync(join(dir, ".docs", "instructions.md"), "utf-8");
  const append = join(dir, ".docs", "instructions.append.md");
  if (existsSync(append)) instructions += "\n\n" + readFileSync(append, "utf-8");
  return { slug, dir, solution, test, instructions };
}

/** Fresh working dir under `parent` — the isolated server's own workspace, so
 *  the model's sandbox allows it and it dies with the server — with the stub +
 *  support files copied in, and the hidden tests WITHHELD. */
export function makeExerciseProject(ex, parent = homedir()) {
  const work = mkdtempSync(join(parent, `aider-${ex.slug}-`));
  const withheld = new Set(ex.test);
  for (const ent of readdirSync(ex.dir)) {
    if (ent.startsWith(".")) continue;          // .meta (example/tests) + .docs — hidden
    if (withheld.has(ent)) continue;            // the graded test file(s)
    const src = join(ex.dir, ent);
    if (statSync(src).isFile()) copyFileSync(src, join(work, ent));
  }
  return work;
}

/**
 * A Python 3 interpreter that verifiably RUNS, as an absolute forward-slash
 * path (valid in Git Bash and in Windows APIs alike). Null when none does.
 *
 * `python3` is not a safe assumption: on this Windows box it resolves to the
 * Microsoft Store alias, which prints "Python was not found" and exits
 * non-zero. The scorer ran exactly that, so EVERY exercise scored FAIL no
 * matter what the model wrote (2026-09-17: grade-school's final code passes all
 * 20 hidden tests and was recorded "FAIL tests-red"). The prompt told the model
 * to use it too, and the model spent a dozen tool calls finding a real one.
 */
let resolvedPython;
export function resolvePython() {
  if (resolvedPython !== undefined) return resolvedPython;
  const candidates = [
    ...(process.env.AIDER_PYTHON ? [[process.env.AIDER_PYTHON, []]] : []),
    ["py", ["-3"]],
    ["python3", []],
    ["python", []],
  ];
  const probe = "import sys; print(sys.version_info[0]); print(sys.executable)";
  for (const [cmd, pre] of candidates) {
    try {
      const out = execFileSync(cmd, [...pre, "-c", probe], { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).toString().trim().split(/\r?\n/);
      if (out[0] === "3" && out[1]) return (resolvedPython = out[1].trim().replace(/\\/g, "/"));
    } catch { /* not this one */ }
  }
  return (resolvedPython = null);
}

/** The task prompt handed to the model. Standard Exercism framing: implement the
 *  stub, keep the public names the tests import, stdlib only, edit in place. */
export function buildPrompt(work, ex) {
  const files = ex.solution.join(", ");
  const python = resolvePython();
  return [
    `Solve this Python coding exercise. Working directory: ${work}`,
    ``,
    `Edit the existing stub file(s) in that directory to implement a correct,`,
    `complete solution: ${files}`,
    `Keep the class and function names / signatures the stub defines — an automated`,
    `test suite imports them by name. Use only the Python standard library. Do NOT`,
    `create new files; edit the stub in place. To run Python here, use this exact`,
    `interpreter: \`${python}\`. When you are done the solution must pass a hidden`,
    `unittest suite. Solve it yourself — do not look the exercise or its tests up online.`,
    ``,
    `--- EXERCISE INSTRUCTIONS ---`,
    ex.instructions.trim(),
  ].join("\n");
}

/** Copy the hidden tests in and run them with stdlib unittest. ok=true iff every
 *  test module exits 0. Ground truth — independent of the model's reply.
 *
 *  `harness` is set when the suite never actually RAN. unittest prints
 *  "Ran N test(s)" whenever it executes — including when the model's module
 *  fails to import, which IS the model's failure — so its absence means the
 *  interpreter or the runner broke, and that row must not be scored. */
export function scoreExercise(work, ex) {
  const python = resolvePython();
  if (!python) return { ok: false, harness: "no working Python 3 interpreter", results: [] };
  const results = [];
  for (const t of ex.test) {
    copyFileSync(join(ex.dir, t), join(work, t));
    const mod = t.replace(/\.py$/, "");
    try {
      const out = execFileSync(python, ["-m", "unittest", mod], { cwd: work, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      results.push({ test: t, ok: true, ran: true, output: String(out) });
    } catch (e) {
      // Killed at the timeout = the model's code hung; the runner did run it.
      const hung = Boolean(e.killed || e.signal);
      const out = `${e.stdout || ""}${e.stderr || ""}${hung ? "\n[killed: tests exceeded 60s — the solution hangs]" : ""}`;
      results.push({ test: t, ok: false, ran: hung || /\bRan \d+ tests?\b/.test(out), output: out.slice(-3000) });
    } finally {
      // Hidden again: a second attempt is shown the failures, never the suite.
      rmSync(join(work, t), { force: true });
      rmSync(join(work, "__pycache__"), { recursive: true, force: true });
    }
  }
  const broken = results.find((r) => !r.ran && !r.ok);
  return {
    ok: results.every((r) => r.ok),
    harness: broken ? `test runner did not run ${broken.test}: ${broken.output.trim().split(/\r?\n/)[0] ?? ""}` : undefined,
    results,
  };
}

/**
 * The second attempt, as Aider's own benchmark runs it: the model is shown the
 * failing test output — never the test file — and asked to fix its code.
 * Aider reports pass@1 and pass@2; a single blind attempt fails a model on
 * details the instructions never state (phone-number's pretty() format appears
 * only in the hidden tests), which is a measurement of the spec, not the model.
 */
export function buildRetryPrompt(ex, score) {
  const errors = score.results.filter((r) => !r.ok).map((r) => r.output.trim()).join("\n\n").slice(-4000);
  return [
    errors,
    ``,
    `####`,
    ``,
    `See the testing errors above.`,
    `The tests are correct, don't try and change them.`,
    `Fix the code in ${ex.solution.join(", ")} to resolve the errors.`,
  ].join("\n");
}

/** Did the model actually change the stub? (An untouched stub → it did nothing.) */
export function solutionChanged(work, ex) {
  for (const f of ex.solution) {
    try {
      const now = readFileSync(join(work, f), "utf-8");
      const orig = readFileSync(join(ex.dir, f), "utf-8");
      if (now.trim() !== orig.trim()) return true;
    } catch { /* missing → treat as unchanged */ }
  }
  return false;
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

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
export { driveChat, activeModel, health, claimsDone, admitsIncomplete, BASE, H } from "../grok-coding-parity/lib.mjs";

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

/** Fresh working dir UNDER $HOME (the guarded sandbox blocks /tmp writes) with
 *  the stub + support files copied in, and the hidden tests WITHHELD. */
export function makeExerciseProject(ex) {
  const work = mkdtempSync(join(homedir(), `lax-aider-${ex.slug}-`));
  const withheld = new Set(ex.test);
  for (const ent of readdirSync(ex.dir)) {
    if (ent.startsWith(".")) continue;          // .meta (example/tests) + .docs — hidden
    if (withheld.has(ent)) continue;            // the graded test file(s)
    const src = join(ex.dir, ent);
    if (statSync(src).isFile()) copyFileSync(src, join(work, ent));
  }
  return work;
}

/** The task prompt handed to the model. Standard Exercism framing: implement the
 *  stub, keep the public names the tests import, stdlib only, edit in place. */
export function buildPrompt(work, ex) {
  const files = ex.solution.join(", ");
  return [
    `Solve this Python coding exercise. Working directory: ${work}`,
    ``,
    `Edit the existing stub file(s) in that directory to implement a correct,`,
    `complete solution: ${files}`,
    `Keep the class and function names / signatures the stub defines — an automated`,
    `test suite imports them by name. Use only the Python standard library. Do NOT`,
    `create new files; edit the stub in place. You may run \`python3\` to check your`,
    `own work. When you are done the solution must pass a hidden unittest suite.`,
    ``,
    `--- EXERCISE INSTRUCTIONS ---`,
    ex.instructions.trim(),
  ].join("\n");
}

/** Copy the hidden tests in and run them with stdlib unittest. ok=true iff every
 *  test module exits 0. Ground truth — independent of the model's reply. */
export function scoreExercise(work, ex) {
  const results = [];
  for (const t of ex.test) {
    copyFileSync(join(ex.dir, t), join(work, t));
    const mod = t.replace(/\.py$/, "");
    try {
      execFileSync("python3", ["-m", "unittest", mod], { cwd: work, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
      results.push({ test: t, ok: true, output: "" });
    } catch (e) {
      const out = `${e.stdout || ""}${e.stderr || ""}`;
      results.push({ test: t, ok: false, output: out.slice(-3000) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
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

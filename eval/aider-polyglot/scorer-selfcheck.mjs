#!/usr/bin/env node
// Scorer self-check — proves the grader before any model is graded by it.
//
// For every exercise in the set: the benchmark's own reference solution must
// PASS, and the untouched stub must FAIL *as a model failure* (the suite ran
// and went red), never as a harness failure. A scorer that fails either check
// would turn harness breakage into model scores, which is exactly what
// happened on 2026-09-17 when `python3` was the Windows Store alias and every
// row came back "FAIL tests-red".
//
//   node eval/aider-polyglot/scorer-selfcheck.mjs            # curated set
//   node eval/aider-polyglot/scorer-selfcheck.mjs --all
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, scoreExercise, cleanup, resolvePython,
} from "./lib.mjs";
import { CURATED } from "./curated.mjs";

ensureBenchmark();
const python = resolvePython();
if (!python) { console.error("HARNESS-ERROR: no working Python 3 interpreter"); process.exit(2); }
console.log(`interpreter: ${python}\n`);

const slugs = process.argv.includes("--all") ? allSlugs() : CURATED;
let bad = 0;
for (const slug of slugs) {
  const ex = loadExercise(slug);

  // Reference solution in place of the stub → must pass.
  const good = makeExerciseProject(ex);
  if (ex.solution.length === 1 && ex.files.includes(".meta/example.py")) {
    writeFileSync(join(good, ex.solution[0]), ex.read(".meta/example.py"));
  }
  const ref = scoreExercise(good, ex);
  cleanup(good);

  // Untouched stub → must fail, and fail as the MODEL's failure.
  const stub = makeExerciseProject(ex);
  const raw = scoreExercise(stub, ex);
  cleanup(stub);

  const refOk = ref.ok && !ref.harness;
  const stubOk = !raw.ok && !raw.harness;
  if (!refOk || !stubOk) bad++;
  console.log(`${slug.padEnd(18)} reference=${refOk ? "PASS" : `BROKEN ${ref.harness ?? ""}`}  stub=${stubOk ? "FAIL(model)" : `BROKEN ${raw.harness ?? "(passed?)"}`}`);
}
console.log(bad ? `\n${bad} exercise(s) cannot be scored honestly — fix before grading a model.` : `\nscorer OK on ${slugs.length} exercises.`);
process.exit(bad ? 1 : 0);

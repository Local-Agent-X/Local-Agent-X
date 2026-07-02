#!/usr/bin/env node
// Run the active LAX model over Aider-polyglot Python exercises and score
// PASS/FAIL from the HIDDEN unittest suite. Surfaces coding failures (incomplete
// solutions, works-on-my-machine, false-done) to drive HARNESS fixes.
//
// Usage:
//   node eval/aider-polyglot/run.mjs                     # curated 12-exercise set
//   node eval/aider-polyglot/run.mjs --all               # all 34
//   node eval/aider-polyglot/run.mjs --slugs forth,poker # explicit set
//   node eval/aider-polyglot/run.mjs --limit 5           # first N of the set
//   node eval/aider-polyglot/run.mjs --timeout 240000    # per-exercise drive cap
//
// Scoring is filesystem ground truth (unittest), never the reply. The reply is
// used only to flag a FALSE-DONE (claimed success while the tests are red).

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, buildPrompt,
  scoreExercise, solutionChanged, cleanup,
  driveChat, activeModel, health, claimsDone, admitsIncomplete,
} from "./lib.mjs";

// A diverse default set spanning easy → hard so a single run surfaces varied
// failure modes without running the full 34.
const CURATED = [
  "grade-school", "wordy", "transpose", "phone-number", "pig-latin", "bowling",
  "poker", "grep", "dominoes", "list-ops", "two-bucket", "forth",
];

function parseArgs(argv) {
  const a = { timeout: 300_000, keep: false, slugs: null, all: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--all") a.all = true;
    else if (k === "--keep") a.keep = true;
    else if (k === "--timeout") a.timeout = parseInt(argv[++i], 10);
    else if (k === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (k === "--slugs") a.slugs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureBenchmark();

  if (!(await health())) { console.error("ERROR: dev server not reachable — start it on :7007 first."); process.exit(2); }
  const model = (await activeModel()) || "unknown";

  let slugs = args.all ? allSlugs() : (args.slugs || CURATED);
  const known = new Set(allSlugs());
  const missing = slugs.filter((s) => !known.has(s));
  if (missing.length) { console.error(`Unknown slugs: ${missing.join(", ")}`); process.exit(2); }
  if (args.limit > 0) slugs = slugs.slice(0, args.limit);

  console.log(`\n=== Aider polyglot (python) · model=${model} · ${slugs.length} exercises ===\n`);
  console.log(`${pad("exercise", 18)} ${pad("result", 8)} ${pad("secs", 6)} ${pad("tools", 6)} note`);
  console.log("-".repeat(72));

  const rows = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const slug of slugs) {
    const ex = loadExercise(slug);
    const work = makeExerciseProject(ex);
    const prompt = buildPrompt(work, ex);
    const sessionId = `aider-${slug}-${stamp}`;
    const drive = await driveChat(prompt, sessionId, args.timeout);
    const changed = solutionChanged(work, ex);
    const score = scoreExercise(work, ex);

    const claimed = claimsDone(drive.text) && !admitsIncomplete(drive.text);
    const falseDone = !score.ok && claimed;
    const result = score.ok ? "PASS" : "FAIL";
    const notes = [];
    if (drive.err) notes.push(`err=${drive.err}`);
    if (!changed) notes.push("stub-untouched");
    if (falseDone) notes.push("FALSE-DONE");
    if (!score.ok && changed) notes.push("tests-red");

    console.log(`${pad(slug, 18)} ${pad(result, 8)} ${pad(drive.secs, 6)} ${pad(drive.tools.length, 6)} ${notes.join(" ")}`);

    rows.push({
      slug, pass: score.ok, secs: drive.secs, tools: drive.tools,
      changed, falseDone, err: drive.err,
      reply: drive.text.slice(0, 1200),
      testOutput: score.ok ? "" : (score.results.find((r) => !r.ok)?.output || "").slice(-2000),
      work: args.keep && !score.ok ? work : undefined,
    });
    if (!(args.keep && !score.ok)) cleanup(work);
  }

  const passed = rows.filter((r) => r.pass).length;
  const falseDones = rows.filter((r) => r.falseDone).length;
  console.log("-".repeat(72));
  console.log(`\nRESULT: ${passed}/${rows.length} passed · ${falseDones} false-done · model=${model}\n`);

  // Persist the full report (with test output + replies) for triage.
  const outDir = join(process.env.HOME, ".cache", "aider-polyglot-reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${model.replace(/\//g, "_")}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ model, stamp, passed, total: rows.length, falseDones, rows }, null, 2));
  console.log(`report: ${outPath}`);

  // List failures with a one-line reason for quick triage.
  const fails = rows.filter((r) => !r.pass);
  if (fails.length) {
    console.log(`\nFAILURES (${fails.length}):`);
    for (const f of fails) {
      const firstErr = (f.testOutput.match(/^\s*(Error|Exception|.*Error:.*|FAILED.*|AttributeError.*|.*Assertion.*)$/mi) || [])[0] || f.testOutput.split("\n").filter(Boolean).slice(-1)[0] || "";
      console.log(`  ${pad(f.slug, 18)} ${f.falseDone ? "[FALSE-DONE] " : ""}${firstErr.trim().slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

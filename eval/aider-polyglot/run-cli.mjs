#!/usr/bin/env node
// Run Aider-polyglot Python exercises through a model's NATIVE CLI harness
// (grok CLI / codex exec) instead of LAX, with the IDENTICAL task prompt and
// the identical hidden-unittest scoring. The controlled comparison: same model,
// same exercise, same scoring — only the harness differs. An exercise the model
// solves under its own CLI but fails under LAX is a LAX harness gap to close;
// one it fails under both is model capability. Only CONSISTENT deltas count —
// single runs are stochastic.
//
// Usage:
//   node eval/aider-polyglot/run-cli.mjs --cli grok                  # curated-12, grok-4.3
//   node eval/aider-polyglot/run-cli.mjs --cli codex                 # curated-12, gpt-5.5
//   node eval/aider-polyglot/run-cli.mjs --cli grok --slugs wordy,forth
//   node eval/aider-polyglot/run-cli.mjs --cli codex --model gpt-5.4 --timeout 420000

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, buildPrompt,
  scoreExercise, solutionChanged, cleanup, claimsDone, admitsIncomplete,
} from "./lib.mjs";

// Same default set as run.mjs so rows line up 1:1 with the LAX runs.
const CURATED = [
  "grade-school", "wordy", "transpose", "phone-number", "pig-latin", "bowling",
  "poker", "grep", "dominoes", "list-ops", "two-bucket", "forth",
];

const CLIS = {
  grok: {
    defaultModel: "grok-4.3",
    // -p single-turn headless; --always-approve = its autonomous mode; --cwd
    // scopes it to the exercise dir. Defaults otherwise — the point is to
    // measure THEIR harness as shipped.
    cmd: (work, prompt, model) => [
      join(homedir(), ".grok", "bin", "grok"),
      ["-p", prompt, "--cwd", work, "-m", model, "--always-approve"],
    ],
  },
  codex: {
    defaultModel: "gpt-5.5",
    // exec = headless mode; workspace-write sandbox (its default autonomy
    // shape); --skip-git-repo-check because the work dir is a bare temp dir.
    cmd: (work, prompt, model) => [
      "codex",
      ["exec", prompt, "-C", work, "-m", model, "--sandbox", "workspace-write", "--skip-git-repo-check"],
    ],
  },
};

function parseArgs(argv) {
  const a = { cli: null, model: null, timeout: 300_000, keep: false, slugs: null, all: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--cli") a.cli = argv[++i];
    else if (k === "--model") a.model = argv[++i];
    else if (k === "--all") a.all = true;
    else if (k === "--keep") a.keep = true;
    else if (k === "--timeout") a.timeout = parseInt(argv[++i], 10);
    else if (k === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (k === "--slugs") a.slugs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

/** Spawn the CLI headless on the exercise; resolve with its stdout tail + timing.
 *  Never rejects — a crashed/timed-out CLI is a FAIL row, not a run abort. */
function driveCli(cliDef, work, prompt, model, timeoutMs) {
  const [bin, args] = cliDef.cmd(work, prompt, model);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = execFile(bin, args, {
      cwd: work,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    }, (err, stdout, stderr) => {
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
      const out = `${stdout || ""}`;
      resolve({
        text: out.trim().slice(-2000),
        err: err ? (err.killed ? `timeout ${timeoutMs}ms` : `exit ${err.code ?? "?"}: ${String(stderr || err.message).slice(0, 200)}`) : "",
        secs,
      });
    });
    // Close stdin NOW. `codex exec` sees a non-TTY stdin and blocks on
    // "Reading additional input from stdin..." until EOF — with the default
    // open pipe it hangs the full timeout and the task never starts. EOF makes
    // it fall back to the positional prompt (probe-verified).
    child.stdin?.end();
  });
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cliDef = CLIS[args.cli];
  if (!cliDef) { console.error(`--cli must be one of: ${Object.keys(CLIS).join(", ")}`); process.exit(2); }
  const model = args.model || cliDef.defaultModel;
  ensureBenchmark();

  let slugs = args.all ? allSlugs() : (args.slugs || CURATED);
  const known = new Set(allSlugs());
  const missing = slugs.filter((s) => !known.has(s));
  if (missing.length) { console.error(`Unknown slugs: ${missing.join(", ")}`); process.exit(2); }
  if (args.limit > 0) slugs = slugs.slice(0, args.limit);

  console.log(`\n=== Aider polyglot (python) · NATIVE CLI harness: ${args.cli} · model=${model} · ${slugs.length} exercises ===\n`);
  console.log(`${pad("exercise", 18)} ${pad("result", 8)} ${pad("secs", 6)} note`);
  console.log("-".repeat(64));

  const rows = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const slug of slugs) {
    const ex = loadExercise(slug);
    const work = makeExerciseProject(ex);
    const prompt = buildPrompt(work, ex); // IDENTICAL prompt to the LAX run
    const drive = await driveCli(cliDef, work, prompt, model, args.timeout);
    const changed = solutionChanged(work, ex);
    const score = scoreExercise(work, ex);

    const claimed = claimsDone(drive.text) && !admitsIncomplete(drive.text);
    const falseDone = !score.ok && claimed;
    const notes = [];
    if (drive.err) notes.push(`err=${drive.err.slice(0, 40)}`);
    if (!changed) notes.push("stub-untouched");
    if (falseDone) notes.push("FALSE-DONE");
    if (!score.ok && changed) notes.push("tests-red");

    console.log(`${pad(slug, 18)} ${pad(score.ok ? "PASS" : "FAIL", 8)} ${pad(drive.secs, 6)} ${notes.join(" ")}`);

    rows.push({
      slug, pass: score.ok, secs: drive.secs, changed, falseDone, err: drive.err,
      reply: drive.text.slice(0, 1200),
      testOutput: score.ok ? "" : (score.results.find((r) => !r.ok)?.output || "").slice(-2000),
      work: args.keep && !score.ok ? work : undefined,
    });
    if (!(args.keep && !score.ok)) cleanup(work);
  }

  const passed = rows.filter((r) => r.pass).length;
  const falseDones = rows.filter((r) => r.falseDone).length;
  console.log("-".repeat(64));
  console.log(`\nRESULT: ${passed}/${rows.length} passed · ${falseDones} false-done · harness=${args.cli}-cli · model=${model}\n`);

  const outDir = join(process.env.HOME, ".cache", "aider-polyglot-reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `cli-${args.cli}_${model.replace(/\//g, "_")}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ harness: `${args.cli}-cli`, model, stamp, passed, total: rows.length, falseDones, rows }, null, 2));
  console.log(`report: ${outPath}`);

  const fails = rows.filter((r) => !r.pass);
  if (fails.length) {
    console.log(`\nFAILURES (${fails.length}):`);
    for (const f of fails) {
      const firstErr = (f.testOutput.match(/^\s*(Error|Exception|.*Error:.*|FAILED.*|AttributeError.*|.*Assertion.*)$/mi) || [])[0] || f.testOutput.split("\n").filter(Boolean).slice(-1)[0] || f.err || "";
      console.log(`  ${pad(f.slug, 18)} ${f.falseDone ? "[FALSE-DONE] " : ""}${firstErr.trim().slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

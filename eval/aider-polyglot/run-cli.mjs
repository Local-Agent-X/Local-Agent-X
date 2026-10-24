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
//   node eval/aider-polyglot/run-cli.mjs --cli hermes --all --timeout 1800000
//
// A CLI that can resume its session (hermes) gets run.mjs's protocol: a failed
// first attempt is shown the test errors and tries once more, and pass@1 and
// pass@2 are both reported.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, buildPrompt, buildRetryPrompt, writeSealed,
  scoreExercise, solutionChanged, cleanup, claimsDone, admitsIncomplete,
} from "./lib.mjs";

// Same default set as run.mjs so rows line up 1:1 with the LAX runs.
const CURATED = [
  "grade-school", "wordy", "transpose", "phone-number", "pig-latin", "bowling",
  "poker", "grep", "dominoes", "list-ops", "two-bucket", "forth",
];

/**
 * Hermes (Nous Research) as its own Terminal-Bench adapter runs it: Harbor's
 * config.yaml (memory and checkpoints off, local terminal), `hermes --yolo chat
 * -q <task> -Q`. A fresh HERMES_HOME per exercise, so nothing carries over;
 * the Claude sign-in is the one the user's Hermes uses (Claude Code's
 * credentials, read from the user's home). Web and browser toolsets are left
 * out, as run.mjs denies LAX its web tools: the benchmark is offline.
 */
const HERMES_EVAL = join(homedir(), ".cache", "hermes-eval");
const HERMES_BIN = process.env.HERMES_BIN || join(HERMES_EVAL, "hermes-v0.22.5", ".venv", "Scripts", "hermes.exe");
const HERMES_OFFLINE_TOOLSETS = "terminal,file,code_execution,todo,skills,delegation,clarify,vision";
const HERMES_CONFIG = [
  "model: MODEL",
  "provider: auto",
  "toolsets:",
  "- hermes-cli",
  "memory:",
  "  memory_enabled: false",
  "  user_profile_enabled: false",
  "terminal:",
  "  backend: local",
  "  timeout: 180",
  "delegation:",
  "  max_iterations: 50",
  "checkpoints:",
  "  enabled: false",
  "",
].join("\n");

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
  hermes: {
    defaultModel: "claude-opus-5-5",
    canResume: true,
    prepare: (model) => {
      mkdirSync(join(HERMES_EVAL, "homes"), { recursive: true });
      const home = mkdtempSync(join(HERMES_EVAL, "homes", "h-"));
      writeFileSync(join(home, "config.yaml"), HERMES_CONFIG.replace("MODEL", model));
      return { home, env: { HERMES_HOME: home } };
    },
    cmd: (work, prompt, model, { resume } = {}) => [
      HERMES_BIN,
      ["--yolo", "chat", "-q", prompt, "-Q", "--model", model, "--provider", "anthropic",
        "--toolsets", HERMES_OFFLINE_TOOLSETS, ...(resume ? ["--resume", "latest"] : [])],
    ],
    // Everything the run wrote under its home: sessions and the state db.
    transcript: (home) => readTree(home),
  },
};

/** Text of every file under `dir` (sessions, state db), for the answer-key check. */
function readTree(dir) {
  let text = "";
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) text += readTree(p);
      else text += readFileSync(p, "latin1");
    } catch { /* locked or gone */ }
  }
  return text;
}

/** Three or more of the hidden suite's own test names in what the run saw (run.mjs sawHiddenTests). */
function sawHiddenTestsIn(text, ex) {
  const names = new Set();
  for (const t of ex.test) for (const m of ex.text(t).matchAll(/def (test_\w+)\(/g)) names.add(m[1]);
  let hits = 0;
  for (const n of names) if (text.includes(n) && ++hits >= 3) return true;
  return false;
}

/** A turn the provider refused (sign-in, quota) says nothing about the model. */
const PROVIDER_REFUSAL = /\b(401|403|429)\b|authenticat|unauthori[sz]ed|usage.?limit|rate.?limit|overloaded|credential/i;

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
function driveCli(cliDef, work, prompt, model, timeoutMs, { env = {}, resume = false } = {}) {
  const [bin, args] = cliDef.cmd(work, prompt, model, { resume });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = execFile(bin, args, {
      cwd: work,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", ...env },
    }, (err, stdout, stderr) => {
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
      const out = `${stdout || ""}`;
      resolve({
        text: out.trim().slice(-2000),
        stderr: String(stderr || "").slice(-2000),
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
  const outDir = join(homedir(), ".cache", "aider-polyglot-reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `cli-${args.cli}_${model.replace(/\//g, "_")}-${stamp}.json`);
  // Only PASS and FAIL are verdicts on the model (run.mjs's rule).
  const tally = () => {
    const scoredRows = rows.filter((r) => r.result === "PASS" || r.result === "FAIL");
    return {
      passed: scoredRows.filter((r) => r.result === "PASS").length,
      passedAt1: scoredRows.filter((r) => r.result === "PASS" && r.passAt1).length,
      scored: scoredRows.length,
      falseDones: rows.filter((r) => r.falseDone).length,
    };
  };
  // Written after every exercise, so a run stopped halfway keeps its rows.
  const save = () => writeSealed(outPath, JSON.stringify({ harness: `${args.cli}-cli`, model, stamp, ...tally(), total: rows.length, rows }, null, 2));
  for (const slug of slugs) {
    const ex = loadExercise(slug);
    const work = makeExerciseProject(ex);
    const prompt = buildPrompt(work, ex); // IDENTICAL prompt to the LAX run
    const prep = cliDef.prepare ? cliDef.prepare(model) : { env: {} };
    const first = await driveCli(cliDef, work, prompt, model, args.timeout, { env: prep.env });
    let score = scoreExercise(work, ex);
    const passAt1 = score.ok;
    // Read before the retry: its prompt carries the failing tests' names.
    const sawTests = cliDef.transcript ? sawHiddenTestsIn(cliDef.transcript(prep.home), ex) : false;
    let second = null;
    if (!score.ok && cliDef.canResume && !PROVIDER_REFUSAL.test(first.stderr + first.text)) {
      second = await driveCli(cliDef, work, buildRetryPrompt(ex, score), model, args.timeout, { env: prep.env, resume: true });
      score = scoreExercise(work, ex);
    }
    const drive = {
      text: (second ?? first).text,
      err: [first.err, second?.err].filter(Boolean).join("; "),
      secs: Number((first.secs + (second?.secs ?? 0)).toFixed(1)),
    };
    const changed = solutionChanged(work, ex);
    const refused = [first, second].filter(Boolean).find((d) => PROVIDER_REFUSAL.test(d.stderr + d.text) && !score.ok);
    // A CLI that exited with an error before touching the stub (a startup
    // crash) never gave the model a turn.
    const crashed = !score.ok && !changed && /^exit /.test(first.err);
    const result = refused || crashed ? "HARNESS" : score.ok ? (sawTests ? "CONTAMINATED" : "PASS") : "FAIL";

    const claimed = claimsDone(drive.text) && !admitsIncomplete(drive.text);
    const falseDone = !score.ok && claimed;
    const notes = [];
    if (drive.err) notes.push(`err=${drive.err.slice(0, 40)}`);
    if (refused) notes.push(`HARNESS-ERROR: provider refused (${(refused.stderr + refused.text).match(PROVIDER_REFUSAL)[0]})`);
    if (crashed && !refused) notes.push("HARNESS-ERROR: the CLI exited before it touched the stub");
    if (sawTests) notes.push("SAW-HIDDEN-TESTS");
    if (!changed) notes.push("stub-untouched");
    if (score.ok && cliDef.canResume) notes.push(passAt1 ? "pass@1" : "pass@2 (after seeing the test errors)");
    if (falseDone) notes.push("FALSE-DONE");
    if (!score.ok && changed) notes.push("tests-red");

    console.log(`${pad(slug, 18)} ${pad(result, 8)} ${pad(drive.secs, 6)} ${notes.join(" ")}`);

    rows.push({
      slug, result, pass: score.ok, passAt1, attempts: second ? 2 : 1, secs: drive.secs, changed, falseDone, err: drive.err,
      reply: drive.text.slice(0, 1200),
      testOutput: score.ok ? "" : (score.results.find((r) => !r.ok)?.output || "").slice(-2000),
      work: args.keep && !score.ok ? work : undefined,
    });
    if (!(args.keep && !score.ok)) { cleanup(work); if (prep.home) cleanup(prep.home); }
    save();
  }

  const { passed, passedAt1, scored, falseDones } = tally();
  console.log("-".repeat(64));
  console.log(`\nRESULT: pass@1 ${passedAt1}/${scored} · pass@2 ${passed}/${scored} · ${falseDones} false-done · harness=${args.cli}-cli · model=${model}`);
  const unscored = rows.filter((r) => r.result === "HARNESS" || r.result === "CONTAMINATED");
  if (unscored.length) console.log(`NOT SCORED (${unscored.length}): ${unscored.map((r) => `${r.slug} (${r.result})`).join("; ")}`);
  console.log("");
  save();

  console.log(`report: ${outPath}.gz`);

  const fails = rows.filter((r) => r.result === "FAIL");
  if (fails.length) {
    console.log(`\nFAILURES (${fails.length}):`);
    for (const f of fails) {
      const firstErr = (f.testOutput.match(/^\s*(Error|Exception|.*Error:.*|FAILED.*|AttributeError.*|.*Assertion.*)$/mi) || [])[0] || f.testOutput.split("\n").filter(Boolean).slice(-1)[0] || f.err || "";
      console.log(`  ${pad(f.slug, 18)} ${f.falseDone ? "[FALSE-DONE] " : ""}${firstErr.trim().slice(0, 80)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

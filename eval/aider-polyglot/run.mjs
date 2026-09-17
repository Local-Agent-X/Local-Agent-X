#!/usr/bin/env -S npx tsx
// Run a LAX model over Aider-polyglot Python exercises and score PASS/FAIL from
// the HIDDEN unittest suite. Surfaces coding failures (incomplete solutions,
// works-on-my-machine, false-done) to drive HARNESS fixes.
//
// Usage (tsx: the isolated-server launcher imports LAX sources):
//   npx tsx eval/aider-polyglot/run.mjs                      # curated 12, muse
//   npx tsx eval/aider-polyglot/run.mjs --provider grok      # a providers.json label
//   npx tsx eval/aider-polyglot/run.mjs --all                # all 34
//   npx tsx eval/aider-polyglot/run.mjs --slugs forth,poker  # explicit set
//   npx tsx eval/aider-polyglot/run.mjs --limit 5            # first N of the set
//   npx tsx eval/aider-polyglot/run.mjs --timeout 1800000    # per-exercise drive cap
//   npx tsx eval/aider-polyglot/run.mjs --keep               # keep failed exercise dirs
//
// Every exercise gets its OWN throwaway LAX server (eval/op-outcomes/isolated.mjs):
// fresh data dir, fresh workspace. The rig used to drive the user's running
// server, and it wrote there — session summaries, and false "facts" about the
// user ("User has a Python coding exercise project grade_school in …") in the
// real memory bank (2026-09-16). It also shared the one local GPU with
// whatever that server ran in the background (a skill_review op on the same
// model, mid-exercise). An exercise's server — and anything it spawned — is
// stopped before the next exercise starts.
//
// Scoring is filesystem ground truth (unittest), never the reply. The reply is
// used only to flag a FALSE-DONE (claimed success while the tests are red).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, buildPrompt,
  scoreExercise, solutionChanged, resolvePython,
  driveChat, claimsDone, admitsIncomplete,
} from "./lib.mjs";
import { CURATED } from "./curated.mjs";
import { assertDistMatchesSource, startIsolatedServer } from "../op-outcomes/isolated.mjs";
import { chatModelsIn } from "../op-outcomes/op-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

function parseArgs(argv) {
  const a = { timeout: 1_800_000, keep: false, slugs: null, all: false, limit: 0, provider: "muse" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--all") a.all = true;
    else if (k === "--keep") a.keep = true;
    else if (k === "--timeout") a.timeout = parseInt(argv[++i], 10);
    else if (k === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (k === "--provider") a.provider = argv[++i];
    else if (k === "--slugs") a.slugs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

const pad = (s, n) => String(s).padEnd(n);

async function runExercise(slug, target, args) {
  const ex = loadExercise(slug);
  const server = await startIsolatedServer({
    repoRoot: REPO_ROOT, provider: target.provider, model: target.model, seedWorkspace: null,
  });
  let keep = false;
  try {
    const work = makeExerciseProject(ex, server.workspace);
    const sessionId = `aider-${slug}`;
    const drive = await driveChat(buildPrompt(work, ex), sessionId, args.timeout, server);
    const died = server.exitedOnItsOwn();
    const changed = solutionChanged(work, ex);
    const score = scoreExercise(work, ex);
    const models = chatModelsIn(server.dataDir);
    const wrongModel = models.length > 0 && !models.every((m) => m === target.model)
      ? `chat ran on ${models.join(", ")}, expected ${target.model}` : null;

    const claimed = claimsDone(drive.text) && !admitsIncomplete(drive.text);
    const falseDone = !score.ok && claimed;
    // Only PASS and FAIL are verdicts on the MODEL. A row the harness broke —
    // server died or unreachable, a turn that would not stop, a suite that never
    // ran, a different model answering — or one that ran out of clock says
    // nothing about capability, and is reported, never scored.
    const harness = died ? `server exited mid-run (code ${died.code}, signal ${died.signal})`
      : score.harness ?? wrongModel
      ?? (/HARNESS-ERROR|^HTTP \d|ECONNREFUSED|fetch failed/i.test(drive.err) ? drive.err : null);
    const timedOut = /^timeout /.test(drive.err);
    const result = harness ? "HARNESS" : score.ok ? "PASS" : timedOut ? "TIMEOUT" : "FAIL";

    const notes = [];
    if (drive.err) notes.push(`err=${drive.err}`);
    if (harness) notes.push(`HARNESS-ERROR: ${harness}`);
    // Web access lets a model fetch the withheld tests; a PASS that did is not
    // a clean measurement. Flagged, not failed — the model may have used it
    // for something else — but it is visible in every row.
    if (drive.tools.some((t) => /^(web_fetch|web_search|browser)/.test(t))) notes.push("used-web");
    if (!changed) notes.push("stub-untouched");
    if (falseDone) notes.push("FALSE-DONE");
    if (!score.ok && changed) notes.push("tests-red");

    keep = args.keep && result !== "PASS";
    return {
      row: {
        slug, result, pass: score.ok, secs: drive.secs, tools: drive.tools,
        changed, falseDone, err: drive.err, harness,
        reply: drive.text.slice(0, 1200),
        testOutput: score.ok ? "" : (score.results.find((r) => !r.ok)?.output || "").slice(-2000),
        kept: keep ? server.root : undefined,
        serverLog: result === "HARNESS" ? server.logTail() : undefined,
      },
      notes,
    };
  } finally {
    await server.stop();
    if (!keep) server.cleanup();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureBenchmark();
  assertDistMatchesSource(REPO_ROOT);
  // Refuse to run rather than score a whole set against a broken scorer.
  const python = resolvePython();
  if (!python) { console.error("HARNESS-ERROR: no working Python 3 interpreter (tried py -3, python3, python; set AIDER_PYTHON)."); process.exit(2); }
  const target = JSON.parse(readFileSync(join(REPO_ROOT, "eval", "op-outcomes", "providers.json"), "utf8"))
    .providers.find((p) => p.label === args.provider);
  if (!target) { console.error(`no provider "${args.provider}" in eval/op-outcomes/providers.json`); process.exit(2); }
  const model = `${target.provider}/${target.model}`;
  console.error(`[aider] ${model} · scoring with ${python} · one isolated server per exercise`);

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
    let out;
    try {
      out = await runExercise(slug, target, args);
    } catch (e) {
      // Boot failure and the like: the harness never gave the model a chance.
      out = { row: { slug, result: "HARNESS", pass: false, secs: 0, tools: [], harness: e.message.split("\n")[0] }, notes: [`HARNESS-ERROR: ${e.message.split("\n")[0]}`] };
    }
    rows.push(out.row);
    console.log(`${pad(slug, 18)} ${pad(out.row.result, 8)} ${pad(out.row.secs, 6)} ${pad(out.row.tools.length, 6)} ${out.notes.join(" ")}`);
  }

  const passed = rows.filter((r) => r.result === "PASS").length;
  const scored = rows.filter((r) => r.result === "PASS" || r.result === "FAIL").length;
  const unscored = rows.filter((r) => r.result === "HARNESS" || r.result === "TIMEOUT");
  const falseDones = rows.filter((r) => r.falseDone).length;
  console.log("-".repeat(72));
  console.log(`\nRESULT: ${passed}/${scored} passed · ${falseDones} false-done · model=${model}`);
  if (unscored.length) {
    console.log(`NOT SCORED (${unscored.length}) — these say nothing about the model until explained: ${unscored.map((r) => `${r.slug}=${r.result}`).join(", ")}`);
  }
  console.log("");

  // Persist the full report (with test output + replies) for triage.
  const outDir = join(homedir(), ".cache", "aider-polyglot-reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${model.replace(/[/:]/g, "_")}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ model, stamp, passed, scored, total: rows.length, falseDones, rows }, null, 2));
  console.log(`report: ${outPath}`);

  // List failures with a one-line reason for quick triage.
  const fails = rows.filter((r) => r.result === "FAIL");
  if (fails.length) {
    console.log(`\nFAILURES (${fails.length}):`);
    for (const f of fails) {
      const firstErr = (f.testOutput.match(/^\s*(Error|Exception|.*Error:.*|FAILED.*|AttributeError.*|.*Assertion.*)$/mi) || [])[0] || f.testOutput.split("\n").filter(Boolean).slice(-1)[0] || "";
      console.log(`  ${pad(f.slug, 18)} ${f.falseDone ? "[FALSE-DONE] " : ""}${firstErr.trim().slice(0, 80)}`);
    }
  }
  // The isolated launcher imports LAX modules that keep watchers alive; the
  // report is written, so end the process (same as op-outcomes/run.mjs).
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

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
// Verdicts: PASS, FAIL, HARNESS, or CONTAMINATED (passed after seeing the
// hidden tests, or after searching the disk outside its workspace — unscored). Web tools are denied. Hitting the time cap is a FAIL
// ("did-not-converge") only when the harness was provably healthy throughout —
// no event-loop stalls, the model getting turns; otherwise it is HARNESS.
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
//
// Two attempts, as Aider's benchmark runs them: a failed first attempt is shown
// the test errors and tries once more. Both pass@1 and pass@2 are reported.

import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBenchmark, allSlugs, loadExercise, makeExerciseProject, buildPrompt, buildRetryPrompt, sealTree, writeSealed,
  scoreExercise, solutionChanged, resolvePython, lookedOutsideWorkspace,
  driveChat, claimsDone, admitsIncomplete,
} from "./lib.mjs";
import { CURATED } from "./curated.mjs";
import { assertDistMatchesSource, startIsolatedServer } from "../op-outcomes/isolated.mjs";
import { chatModelsIn, opTurnCount, toolCalls, toolResultText } from "../op-outcomes/op-store.mjs";

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

/**
 * The benchmark is offline, as Aider's own is. With web tools a model can fetch
 * the withheld test file — muse did exactly that on grade-school (2026-09-17),
 * pulling grade_school_test.py from the polyglot-benchmark repo, and a PASS
 * built on the answer key measures nothing. Seeded into each exercise's server;
 * LAX merges its own policy under them.
 */
const OFFLINE_REASON = "Offline benchmark: solve this from the exercise instructions and the stub — network lookups are disabled for this run.";
const OFFLINE_RULES = ["web_fetch", "web_search", "browser", "http_request"].map((tool) => ({
  id: `eval-offline-${tool}`, tool, decision: "deny", reason: OFFLINE_REASON, priority: 100,
}));

/**
 * Did the model SEE the hidden tests? A tool deny does not close every door
 * (a shell can still download a file), so this reads what the model was shown:
 * three or more of the suite's own test names in its tool results means the
 * answer key reached it, by whatever route. Three, because a model writing its
 * own tests may reuse one obvious name, not a run of them.
 */
function sawHiddenTests(dataDir, ex) {
  const names = new Set();
  for (const t of ex.test) {
    for (const m of ex.text(t).matchAll(/def (test_\w+)\(/g)) names.add(m[1]);
  }
  const shown = toolResultText(dataDir);
  let hits = 0;
  for (const n of names) if (shown.includes(n) && ++hits >= 3) return true;
  return false;
}

/** The server froze long enough to matter: 30s in total, or 15s at once. */
function stallDistress(server) {
  let log = "";
  try { log = readFileSync(join(server.dataDir, "logs", "server.log"), "utf8"); } catch { /* no log yet */ }
  const stalls = [...log.matchAll(/event loop blocked for (\d+)ms/g)].map((m) => Number(m[1]));
  const stalled = stalls.reduce((a, b) => a + b, 0);
  return stalled > 30_000 || stalls.some((ms) => ms > 15_000)
    ? `event loop stalled ${Math.round(stalled / 1000)}s across ${stalls.length} block(s)`
    : null;
}

/**
 * Was the harness healthy for the whole drive? Null when it was; otherwise
 * the reason it was not.
 *
 * This is what decides whether a run that hit the time cap is a verdict on the
 * model. A fixed budget is how benchmarks score: a model that is working the
 * whole time and still has not solved the exercise when the clock runs out has
 * failed it. But the same timeout is meaningless if the server's event loop
 * froze, or the model was not getting turns at all — the harness ate the clock.
 */
function harnessDistress(server, driveSecs) {
  const stalled = stallDistress(server);
  if (stalled) return stalled;
  // A working model takes a turn every few seconds; far fewer means it was
  // waiting on something that was not the model.
  const turns = opTurnCount(server.dataDir);
  const floor = Math.max(3, Math.floor(driveSecs / 120));
  if (turns < floor) return `only ${turns} model turn(s) in ${Math.round(driveSecs)}s`;
  return null;
}

async function runExercise(slug, target, args, evidenceDir) {
  const ex = loadExercise(slug);
  const server = await startIsolatedServer({
    repoRoot: REPO_ROOT, provider: target.provider, model: target.model, seedWorkspace: null,
    toolPolicyRules: OFFLINE_RULES,
    // Two attempts, each up to the drive cap, plus settle and scoring time.
    maxLifetimeMs: 2 * args.timeout + 15 * 60_000,
  });
  let keep = false;
  try {
    const work = makeExerciseProject(ex, server.workspace);
    const sessionId = `aider-${slug}`;
    const first = await driveChat(buildPrompt(work, ex), sessionId, args.timeout, server);
    let score = scoreExercise(work, ex);
    const passAt1 = score.ok;
    // Aider's protocol: a failed first attempt is shown the test errors and
    // gets one more try in the same conversation. Not after a harness break —
    // that row is not scored either way.
    let second = null;
    if (!score.ok && !score.harness && !server.exitedOnItsOwn()
      && !/HARNESS-ERROR|^HTTP \d|ECONNREFUSED|fetch failed/i.test(first.err)) {
      second = await driveChat(buildRetryPrompt(ex, score), sessionId, args.timeout, server);
      score = scoreExercise(work, ex);
    }
    const last = second ?? first;
    const drive = {
      text: last.text,
      tools: [...first.tools, ...(second?.tools ?? [])],
      err: [first.err, second?.err].filter(Boolean).join("; "),
      recovered: [...(first.recovered ?? []), ...(second?.recovered ?? [])],
      secs: Number((first.secs + (second?.secs ?? 0)).toFixed(1)),
    };
    const died = server.exitedOnItsOwn();
    const changed = solutionChanged(work, ex);
    const models = chatModelsIn(server.dataDir);
    const wrongModel = models.length > 0 && !models.every((m) => m === target.model)
      ? `chat ran on ${models.join(", ")}, expected ${target.model}` : null;

    const claimed = claimsDone(drive.text) && !admitsIncomplete(drive.text);
    const falseDone = !score.ok && claimed;
    // Only PASS and FAIL are verdicts on the MODEL. A row the harness broke —
    // server died or unreachable, a turn that would not stop, a suite that never
    // ran, a different model answering, or a timeout the harness caused — says
    // nothing about capability, and is reported, never scored.
    const timedOut = /(^|; )timeout /.test(drive.err);
    const harness = died ? `server exited mid-run (code ${died.code}, signal ${died.signal})`
      : score.harness ?? wrongModel
      ?? (/HARNESS-ERROR|^HTTP \d|ECONNREFUSED|fetch failed/i.test(drive.err) ? drive.err : null)
      // A timeout is the model's failure only if the harness held up. Any other
      // failure is too: a server that froze for 15s at a time (poker, run 16)
      // was not giving the model a fair run whether or not it hit the clock.
      ?? (!score.ok ? (timedOut ? harnessDistress(server, drive.secs) : stallDistress(server)) : null);
    // A PASS on the leaked answer key is not a capability result. A FAIL with
    // it still is — the model had every advantage and did not get there.
    const sawTests = sawHiddenTests(server.dataDir, ex);
    const lookedElsewhere = lookedOutsideWorkspace(toolCalls(server.dataDir), ex, server.workspaceRoot);
    const contaminated = sawTests || lookedElsewhere;
    const result = harness ? "HARNESS" : score.ok ? (contaminated ? "CONTAMINATED" : "PASS") : "FAIL";

    const notes = [];
    if (drive.err) notes.push(`err=${drive.err}`);
    if (drive.recovered.length) notes.push(`recovered-from=${drive.recovered.length}`);
    if (harness) notes.push(`HARNESS-ERROR: ${harness}`);
    // Web access lets a model fetch the withheld tests; a PASS that did is not
    // a clean measurement. Flagged, not failed — the model may have used it
    // for something else — but it is visible in every row.
    if (drive.tools.some((t) => /^(web_fetch|web_search|browser|http_request)/.test(t))) notes.push("tried-web (denied)");
    if (sawTests) notes.push("SAW-HIDDEN-TESTS");
    if (lookedElsewhere) notes.push("LOOKED-OUTSIDE-WORKSPACE");
    if (timedOut && result === "FAIL") notes.push("did-not-converge (harness healthy, time budget spent)");
    if (!changed) notes.push("stub-untouched");
    if (result === "PASS") notes.push(passAt1 ? "pass@1" : "pass@2 (after seeing the test errors)");
    if (falseDone) notes.push("FALSE-DONE");
    if (!score.ok && changed) notes.push("tests-red");

    keep = args.keep && result !== "PASS";
    return {
      row: {
        slug, result, pass: score.ok, passAt1, attempts: second ? 2 : 1, secs: drive.secs, tools: drive.tools,
        changed, falseDone, err: drive.err, recovered: drive.recovered, harness,
        reply: drive.text.slice(0, 1200),
        testOutput: score.ok ? "" : (score.results.find((r) => !r.ok)?.output || "").slice(-2000),
        kept: keep ? server.roots : undefined,
        evidence: evidenceDir,
        serverLog: result === "HARNESS" ? server.logTail() : undefined,
      },
      notes,
    };
  } finally {
    await server.stop();
    keepEvidence(server.dataDir, evidenceDir);
    keepStallProfiles(server.dataDir, slug);
    if (!keep) server.cleanup();
  }
}

/**
 * Everything needed to attribute a result — the op store (turns, guard fires,
 * terminal reason) and the server log — copied out before the data dir is
 * deleted. A FAIL nobody can explain is not a verdict: grade-school's first
 * clean-run FAIL (2026-09-17) ended at 468s with no timeout, and the one
 * directory that said why had already been removed.
 */
function keepEvidence(dataDir, dest) {
  for (const part of ["operations", join("logs", "server.log")]) sealTree(join(dataDir, part), join(dest, part));
}

/** Stall profiles die with the server's data dir; the reports dir outlives it. */
function keepStallProfiles(dataDir, slug) {
  const logs = join(dataDir, "logs");
  let files = [];
  try { files = readdirSync(logs).filter((f) => f.startsWith("loop-stall-") && f.endsWith(".cpuprofile")); } catch { return; }
  if (!files.length) return;
  const dest = join(homedir(), ".cache", "aider-polyglot-reports", "stall-profiles", slug);
  mkdirSync(dest, { recursive: true });
  for (const f of files) copyFileSync(join(logs, f), join(dest, f));
  console.error(`[aider] ${slug}: ${files.length} stall profile(s) → ${dest}`);
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
  const outDir = join(homedir(), ".cache", "aider-polyglot-reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${model.replace(/[/:]/g, "_")}-${stamp}.json`); // written as .json.gz
  const tally = () => {
    const scoredRows = rows.filter((r) => r.result === "PASS" || r.result === "FAIL");
    return {
      passed: scoredRows.filter((r) => r.result === "PASS").length,
      passedAt1: scoredRows.filter((r) => r.result === "PASS" && r.passAt1).length,
      scored: scoredRows.length,
      falseDones: rows.filter((r) => r.falseDone).length,
    };
  };
  // Written after EVERY exercise: a run that is stopped halfway still leaves
  // its results and the evidence paths behind.
  const save = () => writeSealed(outPath, JSON.stringify({ model, stamp, ...tally(), total: rows.length, rows }, null, 2));
  for (const slug of slugs) {
    let out;
    try {
      out = await runExercise(slug, target, args, join(outDir, "evidence", stamp, slug));
    } catch (e) {
      // Boot failure and the like: the harness never gave the model a chance.
      out = { row: { slug, result: "HARNESS", pass: false, secs: 0, tools: [], harness: e.message.split("\n")[0] }, notes: [`HARNESS-ERROR: ${e.message.split("\n")[0]}`] };
    }
    rows.push(out.row);
    save();
    console.log(`${pad(slug, 18)} ${pad(out.row.result, 8)} ${pad(out.row.secs, 6)} ${pad(out.row.tools.length, 6)} ${out.notes.join(" ")}`);
  }

  const { passed, passedAt1, scored, falseDones } = tally();
  const unscored = rows.filter((r) => r.result === "HARNESS" || r.result === "CONTAMINATED");
  console.log("-".repeat(72));
  console.log(`\nRESULT: pass@1 ${passedAt1}/${scored} · pass@2 ${passed}/${scored} · ${falseDones} false-done · model=${model}`);
  if (unscored.length) {
    console.log(`NOT SCORED (${unscored.length}) — these say nothing about the model: ${unscored.map((r) => `${r.slug} (${r.harness ?? "saw the hidden tests or searched outside its workspace"})`).join("; ")}`);
  }
  console.log("");

  save();
  console.log(`report: ${outPath}.gz`);

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

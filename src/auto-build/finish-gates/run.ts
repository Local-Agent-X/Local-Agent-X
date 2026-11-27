/**
 * The finish gates, run by the engine when a build lands its plan's last
 * chunk: the /greenfield skill's "do not end at green" (references/gates.md),
 * which LAX's engine left to the chat. label-check's run ended at its last
 * chunk, and its chat stopped to ask the owner whether to start them
 * (2026-11-23); the same app built under the skill was judged whole, attacked
 * from four angles and fixed before anyone called it done.
 *
 * A round: the whole sealed suite judged on the base, and the break-it agents
 * (breakers.ts) over the finished app. What fails becomes fix chunks, built
 * like plan chunks (the review, the judge, the skeptic, the fix rounds), then
 * a second round checks again. Bounded: at most two fix rounds of at most five
 * fix chunks, and a round that finds what the one before it found ends them.
 * It never halts to ask: the build ends "complete" with its open items named,
 * and the chat is told each one (orchestrator/report-to-chat.ts).
 *
 * A build with a lead asks it when the rounds are used up with fixable items
 * left: one more round (up to LEAD_FIX_ROUNDS in all), or end with them listed.
 */

import { finishDeadline, MIN_FINISH_MS, spanOf, timeIsUp } from "./time-limit.js";
import { FIX_THE_CLASS } from "../chunk-review/skeptic-bar.js";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { listScenarios } from "../../holdout/store.js";
import { projectHoldoutDir } from "../../holdout/paths.js";
import { leavingTrackedFilesAsFound } from "../git-helpers.js";
import { readLaunchSpec } from "../scenario-scorer/launch-spec.js";
import { scoreScenarioFiles } from "../scenario-scorer/phase-gate-runner.js";
import type { ScoreReport } from "../scenario-scorer/types.js";
import type { ParsedChunk } from "../plan-parser.js";
import type { EmitFn, LoopOptions, LoopResult } from "../loop/types.js";
import { runBreakers, type BreakerResult } from "./breakers.js";
import { askLeadBuildCall } from "../advisor/lead-decisions.js";
import { FIX_CHUNK_PHASE, fixChunkNumber, fixChunkTitle, nextFinishRunBase, splitFromFix, type FinishProgress } from "./fix-chunk.js";
import { parsePlanFile } from "../plan-parser.js";
import { owedChecks } from "../failure-recovery.js";

const MAX_FIX_ROUNDS = 2;
/** The ceiling on fix rounds when the build's lead asks for more. */
const LEAD_FIX_ROUNDS = 4;
const MAX_FIX_CHUNKS = 5;

export interface SuiteJudging { failed: ScoreReport[]; unjudged: ScoreReport[]; note?: string }

export interface FinishInput {
  opts: LoopOptions;
  result: LoopResult;
  /** The run's window went to the plan's last chunk, so a complete run means
   *  every chunk of the plan is on the project. Not read off which chunk
   *  landed last: a chunk set aside earlier lands after the ones numbered
   *  above it, and a build that ended on it skipped these checks. */
  reachedPlanEnd: boolean;
  emit: EmitFn;
  /** Builds fix chunks the way the serial loop builds a plan's (loop/run.ts). */
  buildFixes: (fixOpts: LoopOptions) => Promise<LoopResult>;
  /** Test seams. */
  breakers?: typeof runBreakers;
  judgeSuite?: (opts: LoopOptions, say: (m: string) => void) => Promise<SuiteJudging>;
  askLead?: typeof askLeadBuildCall;
}

/** Whether the build's lead wants another fix round for what is still open. */
async function leadWantsAnotherRound(input: FinishInput, at: number, round: number, items: string[]): Promise<boolean> {
  const lead = input.opts.buildLead;
  if (!lead || round > LEAD_FIX_ROUNDS) return false;
  const decision = await (input.askLead ?? askLeadBuildCall)(lead, {
    kind: "finish",
    title: `The finish checks' ${round - 1} fix round(s) are used up with items still open`,
    evidence: `After the last chunk landed, the whole sealed suite was judged and break-it agents attacked the app. Still open:\n${items.map((i) => `- ${i}`).join("\n")}`,
    answers: {
      continue: `one more fix round on what is open (at most ${LEAD_FIX_ROUNDS} in all)`,
      accept: "end the build; each item is listed as open in the report to the owner",
    },
    chunkNumber: at, totalChunks: input.opts.plan.chunks.length,
  }, { signal: input.opts.signal });
  return decision?.action === "continue";
}

/** The whole sealed suite, judged on the base. */
export async function judgeWholeSuite(opts: LoopOptions, say: (m: string) => void): Promise<SuiteJudging> {
  const project = basename(opts.projectDir);
  const suite = listScenarios(project);
  const dir = projectHoldoutDir(project);
  if (suite.length === 0 || !dir) return { failed: [], unjudged: [], note: "no sealed scenario suite: the app was not judged against held-out scenarios" };
  const read = readLaunchSpec(opts.projectDir);
  if (read.kind !== "ok") return { failed: [], unjudged: [], note: `the sealed suite was not judged: ${read.kind === "invalid" ? read.reason : "no .lax-launch.json"}` };
  const { value: out } = await leavingTrackedFilesAsFound(opts.projectDir, () => scoreScenarioFiles({
    projectDir: opts.projectDir, launch: read.spec, scenarioPaths: suite.map((f) => join(dir, f)), signal: opts.signal, onProgress: (m) => say(`[suite] ${m}`),
  }));
  if (out.kind === "error" || out.kind === "no-spec") return { failed: [], unjudged: [], note: `the sealed suite could not be judged: ${out.reason}` };
  if (out.kind === "proceed") return { failed: [], unjudged: [] };
  return { failed: out.kind === "failures" ? out.failedReports : [], unjudged: out.unjudgedReports };
}

const scenarioNumber = (r: ScoreReport): string => (basename(r.scenarioPath).match(/^(\d+)/) || [])[1] ?? "";
const fixable = (b: BreakerResult) => b.findings.filter((f) => f.severity !== "low");
/**
 * What a round's fix chunks take on. The first round fixes everything that is
 * not low. Later rounds fix critical and high only: a break-it agent sent at
 * an app again finds new medium things every time, and fixing all of them
 * every round is how one build spent far more on finish fixes than on
 * building, with the count going from 17 to 19 (label-check-sol,
 * 2026-11-25). What a later round finds below high is listed for the owner.
 */
const fixedIn = (round: number) => (f: BreakerResult["findings"][number]): boolean =>
  round <= 1 ? f.severity !== "low" : f.severity === "critical" || f.severity === "high";

/** Fix chunks for what a round found: one for the failing scenarios, one per
 *  angle with a critical, high or medium finding. */
export function fixChunksFor(round: number, suite: SuiteJudging, breakers: BreakerResult[], runBase = 0): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const next = (title: string, slice: string, scenarios: string, doneWhen: string): void => {
    chunks.push({
      number: fixChunkNumber(runBase, round, chunks.length + 1), title: fixChunkTitle(round, title), phase: FIX_CHUNK_PHASE,
      klass: "trunk", slice, dependsOn: [], scenarios, doneWhen, rawSection: "",
    });
  };
  if (suite.failed.length > 0) {
    next("failing scenarios",
      `Make these held-out scenarios pass. What the judge saw:\n${suite.failed.map((r) => `- ${basename(r.scenarioPath)}: ${r.score}/10. ${r.reasoning}${r.failedCriteria.length ? ` Failed: ${r.failedCriteria.join("; ")}.` : ""}`).join("\n")}`,
      suite.failed.map(scenarioNumber).filter(Boolean).join(", ") || "—",
      "Each scenario named passes when judged, and the scenarios that passed still pass.");
  }
  for (const b of breakers) {
    const found = b.findings.filter(fixedIn(round));
    if (found.length === 0) continue;
    next(`${b.persona} findings`,
      `A break-it agent (${b.persona}) found these in the finished app:\n${found.map((f) => `- [${f.severity}] ${f.text}`).join("\n")}\n\n${FIX_THE_CLASS}`,
      "—", "Each finding above, and inputs of the same kind, no longer reproduce, shown by tests that fail on the code before this chunk.");
  }
  return chunks.slice(0, MAX_FIX_CHUNKS);
}

/** What a round left that nobody fixed, one line each. */
function openItemsOf(suite: SuiteJudging, breakers: BreakerResult[], lows = true): string[] {
  const items: string[] = [];
  if (suite.note) items.push(suite.note);
  for (const r of suite.failed) items.push(`scenario ${basename(r.scenarioPath)} fails (${r.score}/10): ${r.reasoning.slice(0, 200)}`);
  for (const r of suite.unjudged) items.push(`scenario ${basename(r.scenarioPath)} could not be judged: ${r.abortReason}`);
  for (const b of breakers) {
    if (b.status === "not-run") items.push(`the ${b.persona} break-it agent did not check the app: ${b.note}`);
    for (const f of b.findings) if (lows || f.severity !== "low") items.push(`${b.persona} [${f.severity}]: ${f.text.slice(0, 240)}`);
  }
  return items;
}

/** The same scenarios still failing, and no fewer fixable findings: the fixes
 *  did not move it. Read on the scenarios, whose names compare; findings are
 *  free text, so a round that only found new ones is left to the round cap,
 *  and to fixedIn, which stops later rounds from fixing anything below high. */
function noProgress(prev: { suite: SuiteJudging; breakers: BreakerResult[] } | null, suite: SuiteJudging, breakers: BreakerResult[]): boolean {
  if (!prev || suite.failed.length === 0) return false;
  const names = (s: SuiteJudging) => s.failed.map((r) => basename(r.scenarioPath)).sort().join(",");
  const count = (bs: BreakerResult[]) => bs.reduce((n, b) => n + fixable(b).length, 0);
  return names(prev.suite) === names(suite) && count(breakers) >= count(prev.breakers);
}

/** What landed with a check that never ran on it: not a pass, so listed. Read
 *  from the build's ledger, so a chunk an earlier run landed is listed too. */
function owedItems(projectDir: string): string[] {
  return owedChecks(projectDir).map((o) => (o.chunk != null ? `chunk ${o.chunk} landed unverified: ${o.why}` : `not checked by the build: ${o.why}`));
}

/** Checks no engine can make: said every time, so nobody reads "complete" as "seen working". */
function ownerItems(projectDir: string): string[] {
  const mobile = ["app.json", "app.config.ts", "app.config.js", "android"].some((f) => existsSync(join(projectDir, f)));
  return [
    ...(mobile ? ["the app has not been run on a phone or emulator by the build: run it there (device_check) before calling it done"] : []),
    "the owner's walkthrough of the finished app is still to do",
  ];
}

/** What one finish round found: its fix chunks, or nothing more to fix. */
type RoundFinding =
  | { kind: "stop" }
  | { kind: "fix"; fixes: ParsedChunk[]; fixRounds: number; seen: { suite: SuiteJudging; breakers: BreakerResult[] } };

function sayer(input: FinishInput): (message: string) => void {
  const total = input.opts.plan.chunks.length;
  return (message) => input.emit({ type: "review-result", chunkNumber: input.result.lastChunk, totalChunks: total, message });
}

/** Judge the suite, send the break-it agents, and say what this round fixes. */
async function judgeRound(
  input: FinishInput,
  r: { round: number; fixRounds: number; runBase: number; prev: RoundFinding | null; open: string[] },
): Promise<RoundFinding> {
  const { opts } = input;
  const say = sayer(input);
  say(`finish checks, round ${r.round}: judging the whole sealed suite and sending the break-it agents at the finished app`);
  const suite = await (input.judgeSuite ?? judgeWholeSuite)(opts, say);
  const found = await (input.breakers ?? runBreakers)({ projectDir: opts.projectDir, signal: opts.signal, parentSessionId: opts.parentSessionId, parentOpId: opts.parentOpId });
  const fixes = fixChunksFor(r.round, suite, found, r.runBase);
  say(`finish checks, round ${r.round}: ${suite.failed.length} scenario(s) failing, ${found.reduce((n, b) => n + fixable(b).length, 0)} finding(s) to fix`);
  const stuck = noProgress(r.prev?.kind === "fix" ? r.prev.seen : null, suite, found);
  let fixRounds = r.fixRounds;
  if (fixes.length > 0 && r.round > fixRounds && !stuck && await leadWantsAnotherRound(input, input.result.lastChunk, r.round, openItemsOf(suite, found))) {
    fixRounds = r.round;
    say(`finish checks: the build lead asked for fix round ${r.round}`);
  }
  if (fixes.length === 0 || r.round > fixRounds || stuck) {
    r.open.push(...openItemsOf(suite, found));
    if (fixes.length > 0) say(`finish checks: stopping with open items (${r.round > fixRounds ? "fix rounds used up" : "the last round's fixes did not move them"})`);
    return { kind: "stop" };
  }
  // What this round does not fix is listed, never lost: low findings always,
  // and from the second round on everything below high.
  const fixed = fixedIn(r.round);
  r.open.push(...openItemsOf({ failed: [], unjudged: [] }, found.map((b) => ({ ...b, findings: b.findings.filter((f) => !fixed(f)) }))));
  return { kind: "fix", fixes, fixRounds, seen: { suite, breakers: found } };
}

/** Parts the build lead split off this round's fix chunks that landed: built
 *  in the same round, since a fix run builds no split-offs of its own. */
function splitPartsToBuild(planPath: string, progress: FinishProgress, landed: Set<number>): ParsedChunk[] {
  if (!existsSync(planPath)) return [];
  const known = new Set(progress.fixes.map((c) => c.number));
  try {
    return parsePlanFile(planPath).chunks.filter((c) => {
      const parent = splitFromFix(c);
      return parent != null && known.has(parent) && (landed.has(parent) || progress.done.includes(parent)) && !known.has(c.number);
    });
  } catch {
    // A plan that no longer parses grew nothing to build; the round ends on its own fixes.
    return [];
  }
}

/** Build the round's fix chunks not yet done, then any parts split off them,
 *  one at a time, starting none once the finish checks' time is up. */
async function buildRound(input: FinishInput, progress: FinishProgress): Promise<{ committed: number; halted: string[]; notStarted: ParsedChunk[] }> {
  const { opts } = input;
  let committed = 0;
  const halted: string[] = [];
  const landed = new Set<number>();
  const notStarted: ParsedChunk[] = [];
  let batch = progress.fixes.filter((c) => !progress.done.includes(c.number));
  while (batch.length > 0 && !opts.signal?.aborted) {
    const [one, ...rest] = batch;
    if (progress.deadline && timeIsUp(progress.deadline)) {
      notStarted.push(...batch);
      break;
    }
    const fixRun = await input.buildFixes({
      ...opts, plan: { ...opts.plan, chunks: [one], phaseGatesRawSection: "" }, startingChunk: one.number,
      maxChunks: undefined, landedChunks: [], maxConcurrentChunks: 1, skipWallProbe: true, finishGates: false,
      onChunkSettled: (n) => {
        if (!progress.done.includes(n)) progress.done.push(n);
        opts.onFinishProgress?.({ ...progress, fixes: [...progress.fixes], done: [...progress.done], open: [...progress.open] });
        opts.onChunkSettled?.(n);
      },
    });
    committed += fixRun.chunksCommitted;
    for (const o of fixRun.outcomes) if (o.action === "proceed") landed.add(o.chunkNumber);
    if (fixRun.status === "halted") halted.push(fixRun.haltReason.slice(0, 400));
    const split = rest.length === 0 ? splitPartsToBuild(opts.planPath, progress, landed) : [];
    if (split.length > 0) {
      progress.fixes.push(...split);
      opts.onFinishProgress?.({ ...progress, fixes: [...progress.fixes], done: [...progress.done], open: [...progress.open] });
    }
    batch = rest.length > 0 ? rest : split;
  }
  return { committed, halted, notStarted };
}

export async function runFinishGates(input: FinishInput): Promise<LoopResult> {
  const { opts, result } = input;
  const plan = opts.plan.chunks;
  if (!opts.finishGates || result.status !== "complete" || !input.reachedPlanEnd || plan.length === 0) return result;
  const say = sayer(input);
  // A pause or a restart in the finish checks goes on from the round it was in.
  const saved = opts.finishProgress;
  const runBase = saved?.runBase ?? nextFinishRunBase(opts.projectDir);
  let chunksCommitted = result.chunksCommitted;
  let prev: RoundFinding | null = null;
  const open: string[] = [...(saved?.open ?? [])];
  let fixRounds = saved?.fixRounds ?? MAX_FIX_ROUNDS;
  const deadline = finishDeadline(opts.projectDir, saved?.deadline);
  say(`finish checks: they may take until ${deadline} (as long as building the app took, at least ${spanOf(MIN_FINISH_MS)})`);
  for (let round = saved?.round ?? 1; round <= fixRounds + 1; round++) {
    if (opts.signal?.aborted) break;
    if (timeIsUp(deadline) && !(saved && round === saved.round)) {
      say(`finish checks: stopping, their time is up`);
      open.push("the finish checks stopped when their time was up: the app was not checked again after the last fixes");
      break;
    }
    let progress: FinishProgress;
    if (saved && round === saved.round) {
      progress = { ...saved, fixes: [...saved.fixes], done: [...saved.done], open, deadline };
      say(`finish checks, round ${round}: going on with its fix chunks (${saved.done.length} of ${saved.fixes.length} done before the build stopped)`);
    } else {
      const found = await judgeRound(input, { round, fixRounds, runBase, prev, open });
      if (found.kind === "stop") break;
      prev = found;
      fixRounds = found.fixRounds;
      progress = { round, fixRounds, runBase, fixes: found.fixes, done: [], open, deadline };
    }
    opts.onFinishProgress?.({ ...progress, fixes: [...progress.fixes], done: [...progress.done], open: [...open] });
    const built = await buildRound(input, progress);
    chunksCommitted += built.committed;
    for (const reason of built.halted) open.push(`finish fix round ${round} did not fully land: ${reason}`);
    if (built.notStarted.length > 0) {
      say(`finish checks: stopping, their time is up; ${built.notStarted.length} fix chunk(s) not started`);
      for (const c of built.notStarted) open.push(`${c.title}, not started (the finish checks' time was up): ${c.slice.replace(/\s+/g, " ").slice(0, 600)}`);
      break;
    }
  }
  open.push(...owedItems(opts.projectDir), ...ownerItems(opts.projectDir));
  say(`finish checks done: ${open.length} open item(s)`);
  return { ...result, chunksCommitted, openItems: open };
}

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
 */

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

const MAX_FIX_ROUNDS = 2;
const MAX_FIX_CHUNKS = 5;
/** Fix chunks are numbered past any plan's, so their branches, set-aside
 *  records and events never collide with a plan chunk's. */
const FIX_CHUNK_BASE = 1000;

export interface SuiteJudging { failed: ScoreReport[]; unjudged: ScoreReport[]; note?: string }

export interface FinishInput {
  opts: LoopOptions;
  result: LoopResult;
  emit: EmitFn;
  /** Builds fix chunks the way the serial loop builds a plan's (loop/run.ts). */
  buildFixes: (fixOpts: LoopOptions) => Promise<LoopResult>;
  /** Test seams. */
  breakers?: typeof runBreakers;
  judgeSuite?: (opts: LoopOptions, say: (m: string) => void) => Promise<SuiteJudging>;
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

/** Fix chunks for what a round found: one for the failing scenarios, one per
 *  angle with a critical, high or medium finding. */
export function fixChunksFor(round: number, suite: SuiteJudging, breakers: BreakerResult[]): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const next = (title: string, slice: string, scenarios: string, doneWhen: string): void => {
    chunks.push({
      number: FIX_CHUNK_BASE + round * 10 + chunks.length + 1, title: `Finish fix ${round}: ${title}`, phase: "Finish",
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
    const found = fixable(b);
    if (found.length === 0) continue;
    next(`${b.persona} findings`,
      `A break-it agent (${b.persona}) found these in the finished app:\n${found.map((f) => `- [${f.severity}] ${f.text}`).join("\n")}`,
      "—", "Each finding above no longer reproduces, shown by a test that fails on the code before this chunk.");
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
 *  free text, so a round that only found new ones is left to the round cap. */
function noProgress(prev: { suite: SuiteJudging; breakers: BreakerResult[] } | null, suite: SuiteJudging, breakers: BreakerResult[]): boolean {
  if (!prev || suite.failed.length === 0) return false;
  const names = (s: SuiteJudging) => s.failed.map((r) => basename(r.scenarioPath)).sort().join(",");
  const count = (bs: BreakerResult[]) => bs.reduce((n, b) => n + fixable(b).length, 0);
  return names(prev.suite) === names(suite) && count(breakers) >= count(prev.breakers);
}

/** Checks no engine can make: said every time, so nobody reads "complete" as "seen working". */
function ownerItems(projectDir: string): string[] {
  const mobile = ["app.json", "app.config.ts", "app.config.js", "android"].some((f) => existsSync(join(projectDir, f)));
  return [
    ...(mobile ? ["the app has not been run on a phone or emulator by the build: run it there (device_check) before calling it done"] : []),
    "the owner's walkthrough of the finished app is still to do",
  ];
}

export async function runFinishGates(input: FinishInput): Promise<LoopResult> {
  const { opts, result, emit } = input;
  const plan = opts.plan.chunks;
  if (!opts.finishGates || result.status !== "complete" || result.lastChunk !== plan[plan.length - 1]?.number) return result;
  const at = result.lastChunk;
  const say = (message: string) => emit({ type: "review-result", chunkNumber: at, totalChunks: plan.length, message });
  const breakers = input.breakers ?? runBreakers;
  const judgeSuite = input.judgeSuite ?? judgeWholeSuite;

  let chunksCommitted = result.chunksCommitted;
  let prev: { suite: SuiteJudging; breakers: BreakerResult[] } | null = null;
  const open: string[] = [];
  for (let round = 1; round <= MAX_FIX_ROUNDS + 1; round++) {
    if (opts.signal?.aborted) break;
    say(`finish checks, round ${round}: judging the whole sealed suite and sending the break-it agents at the finished app`);
    const suite = await judgeSuite(opts, say);
    const found = await breakers({ projectDir: opts.projectDir, signal: opts.signal, parentSessionId: opts.parentSessionId, parentOpId: opts.parentOpId });
    const fixes = fixChunksFor(round, suite, found);
    say(`finish checks, round ${round}: ${suite.failed.length} scenario(s) failing, ${found.reduce((n, b) => n + fixable(b).length, 0)} finding(s) to fix`);
    if (fixes.length === 0 || round > MAX_FIX_ROUNDS || noProgress(prev, suite, found)) {
      open.push(...openItemsOf(suite, found));
      if (fixes.length > 0) say(`finish checks: stopping with open items (${round > MAX_FIX_ROUNDS ? "fix rounds used up" : "the last round's fixes did not move them"})`);
      break;
    }
    prev = { suite, breakers: found };
    // Low findings are listed, never fixed; the rest go to fix chunks.
    open.push(...openItemsOf({ failed: [], unjudged: [] }, found.map((b) => ({ ...b, findings: b.findings.filter((f) => f.severity === "low") }))));
    const fixRun = await input.buildFixes({
      ...opts, plan: { ...opts.plan, chunks: fixes, phaseGatesRawSection: "" }, startingChunk: fixes[0].number,
      maxChunks: undefined, landedChunks: [], maxConcurrentChunks: 1, skipWallProbe: true, finishGates: false,
    });
    chunksCommitted += fixRun.chunksCommitted;
    if (fixRun.status === "halted") open.push(`finish fix round ${round} did not fully land: ${fixRun.haltReason.slice(0, 400)}`);
  }
  open.push(...ownerItems(opts.projectDir));
  say(`finish checks done: ${open.length} open item(s)`);
  return { ...result, chunksCommitted, openItems: open };
}

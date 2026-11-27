/**
 * A chunk the review pushed back: fix it, round by round.
 *
 * Each round asks the advisor what to do with the review's finding, builds the
 * chunk again with that finding in hand, and has the result reviewed like the
 * first attempt. A round that comes back clean ends it. One retry and then a
 * halt was the rule until 2026-11-22, when a reviewer found a real hole in a
 * chunk, the worker closed it, the reviewer found a different one, and the
 * whole build stopped: a second finding that is NEW is progress, not failure.
 *
 * So the rounds go on while each one changes what the review says, up to
 * MAX_FIX_ROUNDS. They stop early when a round changes nothing (the review
 * says the same thing again: more of the same will not help), when the advisor
 * says halt, or when a spec amendment cannot be applied. Every round's brief
 * carries the earlier rounds' findings, so a fix does not undo a previous one.
 *
 * A build with a lead (advisor/lead-chat.ts) asks the lead instead, every
 * round (lead-rounds.ts): it can keep a chunk going while it makes progress,
 * accept it with follow-ups, narrow an open-ended contract, or park it for the
 * owner, and MAX_LEAD_ROUNDS is only a ceiling on cost: at the ceiling the
 * lead still has the last word, landing or parking the chunk, or it is set
 * aside. A round the lead does not answer is decided by the rules above.
 *
 * When the lead says "continue", the round goes back to the worker that built
 * the last one, its conversation intact (lastTranscript, InvokeOpts
 * priorMessages), told only what the review found: it knows what it tried.
 * "fresh", a finding that came back unchanged, a worker that did not finish,
 * and every round the rules decide start a new worker from the full brief.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ParsedPlan, ParsedChunk } from "../plan-parser.js";
import type { ChunkReviewOutcome, ReviewAction } from "../chunk-review/index.js";
import type { JudgmentHook } from "../chunk-review/judgment-hook.js";
import { consultAdvisor } from "../advisor/index.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "../loop-effects.js";
import type { EmitFn } from "./types.js";
import { safeGet } from "./types.js";
import { runChunkOnce } from "./run-chunk-once.js";
import { parsePlanFile } from "../plan-parser.js";
import type { ChunkJudge } from "../chunk-review/chunk-verdict.js";
import type { BuildLeadRef } from "../advisor/lead-chat.js";
import { MAX_LEAD_ROUNDS, planLeadRound, type LeadRoundPlan } from "./lead-rounds.js";
import { isFinishFixChunk, landsWhatItFixed } from "../finish-gates/fix-chunk.js";
import { renderChunkReport } from "../chunk-review/chunk-report.js";

/** Rebuilds a pushed-back chunk gets after its first attempt. */
export const MAX_FIX_ROUNDS = 3;
/**
 * Rounds a finish fix takes, with a lead or without: it fixes what the
 * break-it agents found in a finished app, and what it does not close goes on
 * the owner's list. With a lead's eight it was hours on one fix chunk
 * (label-check-grok, 2026-11-26); the owner ruled three.
 */
export const MAX_FINISH_FIX_ROUNDS = 3;
const roundCeiling = (chunk: ParsedChunk, byLead: boolean): number =>
  isFinishFixChunk(chunk) ? MAX_FINISH_FIX_ROUNDS : byLead ? MAX_LEAD_ROUNDS : MAX_FIX_ROUNDS;

export interface HandlePushBackOptions {
  chunk: ParsedChunk;
  totalChunks: number;
  planPath: string;
  plan: ParsedPlan;
  projectDir: string;
  preSha: string;
  subprocessTimeoutMs?: number;
  signal?: AbortSignal;
  emit: EmitFn;
  judgmentHook?: JudgmentHook;
  /** Orchestrator op id — threaded onto the retry worker's spawn so a
   *  respawned chunk's card nests under the orchestrator card too. Undefined
   *  → retry worker card renders as a root, unchanged. */
  parentOpId?: string;
  outcome: ChunkReviewOutcome;
  /** Carried onto the retry so it runs and is judged like the first attempt:
   *  the chat it works for (whose model it runs on), and the chunk judge. */
  parentSessionId?: string;
  chunkJudge?: ChunkJudge;
  baseProjectDir?: string;
  workerIndex?: number;
  /** Findings from earlier runs of a set-aside chunk (carry-over.ts), kept
   *  fixed in every round like this run's own earlier rounds. */
  earlierFindings?: string[];
  /** The build's lead, when it has one: it decides each round. */
  buildLead?: BuildLeadRef;
  /** The conversation of the worker that built the attempt being fixed. */
  lastTranscript?: ChatCompletionMessageParam[];
  /** Each round's conversation as it ends, for whoever keeps it (chunk-attempt.ts). */
  onTranscript?: (messages: ChatCompletionMessageParam[]) => void;
  /** The round to count from: a chunk resumed after a pause goes on from the
   *  round it was on (orchestrator/run-control.ts). Default 1. */
  firstRound?: number;
  /** Each round as it starts: its number and every finding so far. */
  onRound?: (round: number, findings: string[]) => void;
}

export interface HandlePushBackResult {
  finalOutcome: ChunkReviewOutcome;
  finalAction: ReviewAction;
}

/** What one round works from: the chunk and plan as they now read (a spec
 *  amendment can sharpen them) and the finding the round has to fix. */
interface Round {
  chunk: ParsedChunk;
  plan: ParsedPlan;
  outcome: ChunkReviewOutcome;
}

type RoundPlan =
  | { kind: "rebuild"; chunk: ParsedChunk; plan: ParsedPlan; retryReason: string }
  | { kind: "halt"; reasoning: string };

/** Whether two reviews say the same thing: the round between them changed nothing. */
function sameFinding(a: ChunkReviewOutcome, b: ChunkReviewOutcome): boolean {
  const norm = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a.reasoning) === norm(b.reasoning);
}

const holdsOn = (o: ChunkReviewOutcome, gate: string) => o.findings.find((f) => f.gate === gate && f.action !== "proceed");

/** Whether two reviews stopped on the same build failure. A command's output
 *  differs run to run in its timings, so those are left out; any other
 *  difference (another test, another count) is a different failure. */
function sameBuildFailure(a: ChunkReviewOutcome, b: ChunkReviewOutcome): boolean {
  const failure = (o: ChunkReviewOutcome) => holdsOn(o, "build-exec")?.reasoning.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m)\b/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const was = failure(b);
  return was !== undefined && failure(a) === was;
}

/** The findings of earlier rounds, for the next brief: a fix must not reopen them. */
function withEarlierFindings(reason: string, earlier: string[]): string {
  if (earlier.length === 0) return reason;
  return `${reason}\n\nFixed in earlier rounds; keep them fixed:\n${earlier.map((f) => `- ${f.replace(/\s+/g, " ").trim().slice(0, 400)}`).join("\n")}`;
}

/** Ask the advisor about this round's finding and turn its answer into what to
 *  do: rebuild (with a hint, or after amending the spec) or halt. */
async function planRound(opts: HandlePushBackOptions, round: Round): Promise<RoundPlan> {
  const { chunk, outcome } = round;
  const { totalChunks, emit } = opts;
  const advice = await consultAdvisor({
    kind: "chunk-review-push-back",
    chunk,
    reviewReason: outcome.reasoning,
    workerReport: renderChunkReport(outcome.report),
    projectDir: opts.projectDir,
  }, { signal: opts.signal });

  const adviceAction = advice?.action || "retry-with-hint";
  emit({
    type: "push-back", chunkNumber: chunk.number, totalChunks,
    message: `push-back advisor: ${adviceAction}${advice?.reasoning ? ` — ${advice.reasoning}` : " (advisor unavailable; mechanical retry)"}`,
  });

  if (adviceAction === "halt") return { kind: "halt", reasoning: advice?.haltReason || outcome.reasoning };

  if (adviceAction === "amend-spec-additively" && advice?.specAddition) {
    const amend = await applyAdditiveSpecAmendment(opts.projectDir, chunk, advice.specAddition);
    if (!amend.ok) return { kind: "halt", reasoning: `additive-diff gate rejected advisor's spec amendment: ${amend.error}` };
    await safeGet(() => commitSpecAmendment(opts.projectDir, chunk));
    // The call is made for the user, so it is said in full where the
    // orchestrator reports from, not only in spec/build-state.md.
    emit({
      type: "spec-amended", chunkNumber: chunk.number, totalChunks,
      message: `advisor amended spec additively before retry (spec/build-state.md): ${advice.specAddition.replace(/\s+/g, " ").slice(0, 600)}`,
    });
    // The amendment may sharpen the current chunk's Slice/Done when. Reparse
    // before retry so the worker and review gates use the amended contract,
    // not the stale object captured at build kickoff.
    try {
      const plan = parsePlanFile(opts.planPath);
      return {
        kind: "rebuild", plan, chunk: plan.chunks.find((c) => c.number === chunk.number) ?? chunk,
        retryReason: `spec was amended to clarify: ${advice.specAddition.slice(0, 200)}`,
      };
    } catch (e) {
      return { kind: "halt", reasoning: `spec amendment left plan invalid: ${(e as Error).message}` };
    }
  }

  // The advisor's hint steers the retry; the review's own finding (a failed
  // scenario's gap, the skeptic's break) still reaches the builder in full.
  const retryReason = adviceAction === "retry-with-hint" && advice?.retryHint
    ? `${advice.retryHint}\n\nWhat the review found:\n${outcome.reasoning}`
    : outcome.reasoning;
  return { kind: "rebuild", chunk, plan: round.plan, retryReason };
}

/** This round's plan: the lead's when the build has one and it answers, else the rules'. */
async function nextRound(opts: HandlePushBackOptions, round: Round, n: number, earlier: string[], repeated: boolean): Promise<{ plan: RoundPlan | LeadRoundPlan; byLead: boolean }> {
  if (opts.buildLead) {
    const plan = await planLeadRound({
      lead: opts.buildLead, chunk: round.chunk, plan: round.plan, outcome: round.outcome, totalChunks: opts.totalChunks,
      round: n - 1, earlier, repeated, projectDir: opts.projectDir, emit: opts.emit, signal: opts.signal,
      ledgerDir: opts.baseProjectDir ?? opts.projectDir,
    });
    if (plan) return { plan, byLead: true };
  }
  // No lead to say whether this machine's refusal is owed: a worker cannot
  // fix the machine, so the chunk waits for the owner with what was printed.
  const refused = holdsOn(round.outcome, "build-refused");
  if (refused) return { plan: { kind: "halt", reasoning: `This machine stopped the chunk's build check, which only the owner can settle. ${refused.reasoning}` }, byLead: false };
  return { plan: await planRound(opts, round), byLead: false };
}

/** The lead's last word on a chunk whose rounds are spent: landed, parked or
 *  set aside on its answer; null when it gave none (the ceiling decides). */
async function finalLeadSay(opts: HandlePushBackOptions, round: Round, n: number, earlier: string[], repeated: boolean): Promise<HandlePushBackResult | null> {
  const plan = await planLeadRound({
    lead: opts.buildLead!, chunk: round.chunk, plan: round.plan, outcome: round.outcome, totalChunks: opts.totalChunks,
    round: n, earlier, repeated, final: true, projectDir: opts.projectDir, emit: opts.emit, signal: opts.signal,
    ledgerDir: opts.baseProjectDir ?? opts.projectDir,
  });
  if (!plan) return null;
  if (plan.kind === "land") return { finalOutcome: plan.outcome, finalAction: "proceed" };
  // A finish fix the lead did not land still keeps what it fixed, unless the lead parked it for the owner.
  if (!(plan.kind === "halt" && plan.parked) && landsWhatItFixed(round.chunk, round.outcome)) return null;
  return { finalAction: "halt", finalOutcome: { ...round.outcome, reasoning: plan.kind === "halt" ? plan.reasoning : round.outcome.reasoning } };
}

/** A finish fix out of rounds that fixed what it could without making the app
 *  worse lands; what is left goes to the next finish round (fix-chunk.ts). */
function landWhatItFixed(opts: HandlePushBackOptions, chunk: ParsedChunk, outcome: ChunkReviewOutcome, rounds: number): HandlePushBackResult {
  const left = outcome.reasoning.replace(/\s+/g, " ").slice(0, 400);
  opts.emit({
    type: "push-back", chunkNumber: chunk.number, totalChunks: opts.totalChunks,
    message: `Chunk ${chunk.number}: ${rounds} fix rounds spent; it lands with what it fixed (its build and tests pass, and nothing it changed made the app worse). Still open, for the next finish round: ${left}`,
  });
  return { finalAction: "proceed", finalOutcome: { ...outcome, action: "proceed", reasoning: `Landed at its round cap with what it fixed. Still open: ${left}` } };
}

export async function handlePushBack(opts: HandlePushBackOptions): Promise<HandlePushBackResult> {
  const { totalChunks, emit } = opts;
  let round: Round = { chunk: opts.chunk, plan: opts.plan, outcome: opts.outcome };
  const earlier: string[] = [...(opts.earlierFindings ?? [])];
  let repeated = false;
  let buildRepeats = 0;
  let transcript = opts.lastTranscript;

  for (let n = Math.min(opts.firstRound ?? 1, roundCeiling(opts.chunk, !!opts.buildLead)); ; n++) {
    opts.onRound?.(n, [...earlier, round.outcome.reasoning]);
    const { plan: next, byLead } = await nextRound(opts, round, n, earlier, repeated);
    if (next.kind === "halt") {
      return { finalAction: "halt", finalOutcome: { ...round.outcome, reasoning: next.reasoning } };
    }
    if (next.kind === "land") return { finalOutcome: next.outcome, finalAction: "proceed" };
    // The same worker goes on, unless the lead asks for a fresh one or, with
    // no lead, the last round came back with the same finding: a worker that
    // did not move it is not the one to try again.
    const fresh = byLead ? (next as { fresh?: boolean }).fresh === true : repeated;
    const goOn = fresh ? undefined : transcript;
    let latest: ChatCompletionMessageParam[] | undefined;
    const rebuilt = await runChunkOnce({
      chunk: next.chunk, totalChunks, planPath: opts.planPath, plan: next.plan,
      projectDir: opts.projectDir, preSha: opts.preSha,
      subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
      retryReason: withEarlierFindings(next.retryReason, earlier),
      judgmentHook: opts.judgmentHook,
      parentOpId: opts.parentOpId,
      parentSessionId: opts.parentSessionId,
      chunkJudge: opts.chunkJudge, baseProjectDir: opts.baseProjectDir, workerIndex: opts.workerIndex,
      ...(goOn ? { continueFrom: goOn } : {}),
      onTranscript: (m: ChatCompletionMessageParam[]) => { latest = m; opts.onTranscript?.(m); },
    });
    transcript = latest;
    if (rebuilt.action !== "push_back") return { finalOutcome: rebuilt, finalAction: rebuilt.action };

    const stuck = sameFinding(rebuilt, round.outcome);
    repeated = stuck;
    // The same build failure after two fix rounds running: a third will not
    // change it. The chunk waits for the owner with the output, instead of
    // spending the rest of its rounds on it.
    buildRepeats = sameBuildFailure(rebuilt, round.outcome) ? buildRepeats + 1 : 0;
    if (buildRepeats >= 2) {
      emit({ type: "push-back", chunkNumber: next.chunk.number, totalChunks, message: `Chunk ${next.chunk.number}: the same build failure came back unchanged from two fix rounds running — not retrying further.` });
      return { finalOutcome: rebuilt, finalAction: "halt" };
    }
    // A lead decides what a repeated finding means; the rules stop on it.
    const ceiling = roundCeiling(next.chunk, byLead);
    if (byLead && n >= ceiling) {
      const last = await finalLeadSay(opts, { chunk: next.chunk, plan: next.plan, outcome: rebuilt }, n, [...earlier, round.outcome.reasoning], stuck);
      if (last) return last;
    }
    if (n >= ceiling && landsWhatItFixed(next.chunk, rebuilt)) return landWhatItFixed(opts, next.chunk, rebuilt, n);
    if ((stuck && !byLead) || n >= ceiling) {
      // Not a "halt" event: whether the build stops or sets the chunk aside is
      // the loop's call (run.ts halts; parallel-waves.ts builds on without it).
      emit({
        type: "push-back", chunkNumber: next.chunk.number, totalChunks,
        message: stuck
          ? `Chunk ${next.chunk.number}: fix round ${n} changed nothing, the review found the same thing again — not retrying further.`
          : `Chunk ${next.chunk.number}: still not green after ${ceiling} fix rounds — not retrying further.`,
      });
      return { finalOutcome: rebuilt, finalAction: "halt" };
    }
    emit({
      type: "push-back", chunkNumber: next.chunk.number, totalChunks,
      message: stuck
        ? `Chunk ${next.chunk.number}: fix round ${n} found the same thing again — asking the build lead.`
        : `Chunk ${next.chunk.number}: fix round ${n} closed what was found and the review found something else — fixing again (${ceiling - n} round(s) left).`,
    });
    earlier.push(round.outcome.reasoning);
    round = { chunk: next.chunk, plan: next.plan, outcome: rebuilt };
  }
}

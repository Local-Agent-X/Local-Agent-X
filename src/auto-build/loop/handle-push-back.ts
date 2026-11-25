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
 * owner, and MAX_LEAD_ROUNDS is only a ceiling on cost. A round the lead does
 * not answer is decided by the rules above.
 */
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

/** Rebuilds a pushed-back chunk gets after its first attempt. */
export const MAX_FIX_ROUNDS = 3;

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
    workerReport:
      `NOTE: ${outcome.report.note || "(empty)"}\n` +
      `SPEC_GAPS: ${outcome.report.specGaps || "(empty)"}\n` +
      `DONE_WHEN: ${outcome.report.doneWhen}`,
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
    });
    if (plan) return { plan, byLead: true };
  }
  return { plan: await planRound(opts, round), byLead: false };
}

export async function handlePushBack(opts: HandlePushBackOptions): Promise<HandlePushBackResult> {
  const { totalChunks, emit } = opts;
  let round: Round = { chunk: opts.chunk, plan: opts.plan, outcome: opts.outcome };
  const earlier: string[] = [...(opts.earlierFindings ?? [])];
  let repeated = false;

  for (let n = 1; ; n++) {
    const { plan: next, byLead } = await nextRound(opts, round, n, earlier, repeated);
    if (next.kind === "halt") {
      return { finalAction: "halt", finalOutcome: { ...round.outcome, reasoning: next.reasoning } };
    }
    if (next.kind === "land") return { finalOutcome: next.outcome, finalAction: "proceed" };
    const rebuilt = await runChunkOnce({
      chunk: next.chunk, totalChunks, planPath: opts.planPath, plan: next.plan,
      projectDir: opts.projectDir, preSha: opts.preSha,
      subprocessTimeoutMs: opts.subprocessTimeoutMs, signal: opts.signal, emit,
      retryReason: withEarlierFindings(next.retryReason, earlier),
      judgmentHook: opts.judgmentHook,
      parentOpId: opts.parentOpId,
      parentSessionId: opts.parentSessionId,
      chunkJudge: opts.chunkJudge, baseProjectDir: opts.baseProjectDir, workerIndex: opts.workerIndex,
    });
    if (rebuilt.action !== "push_back") return { finalOutcome: rebuilt, finalAction: rebuilt.action };

    const stuck = sameFinding(rebuilt, round.outcome);
    repeated = stuck;
    // A lead decides what a repeated finding means; the rules stop on it.
    const ceiling = byLead ? MAX_LEAD_ROUNDS : MAX_FIX_ROUNDS;
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

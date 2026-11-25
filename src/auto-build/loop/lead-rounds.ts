/**
 * A fix round decided by the build's lead (advisor/lead-decisions.ts) instead
 * of the engine's fixed rules: what the lead said, turned into what the round
 * does, with the engine's own guards on it.
 *
 *   continue / fresh  rebuild with the lead's instruction and the finding
 *   accept            land the chunk; what is left goes on record as follow-ups
 *   narrow            the chunk's done-when becomes the lead's, on record; rebuild
 *   park              stop the build on the owner's question
 *
 * Guarded: a chunk whose build or tests fail, or whose held-out scenarios
 * fail, is never accepted, whatever the lead says; the worker is sent back.
 * Accepting and narrowing are recorded in spec/build-state.md and committed,
 * so the decision outlives the run.
 *
 * When the chunk's rounds are spent the lead still has the last word
 * (`final`): accept lands it, park stops for the owner, and any answer that
 * would build again sets it aside. The engine used to set it aside on its own
 * at the ceiling, never asking the one agent holding the whole build.
 */
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import { askLead, type LeadDecision } from "../advisor/lead-decisions.js";
import type { BuildLeadRef } from "../advisor/lead-chat.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "../loop-effects.js";
import { safeGet, type EmitFn } from "./types.js";

/** Rounds a chunk may take while its lead keeps it going: a ceiling on cost,
 *  not the rule (the lead stops it sooner, or accepts, or narrows). */
export const MAX_LEAD_ROUNDS = 8;

export type LeadRoundPlan =
  | { kind: "rebuild"; chunk: ParsedChunk; plan: ParsedPlan; retryReason: string }
  | { kind: "land"; outcome: ChunkReviewOutcome }
  | { kind: "halt"; reasoning: string };

export interface LeadRoundInput {
  lead: BuildLeadRef;
  chunk: ParsedChunk;
  plan: ParsedPlan;
  outcome: ChunkReviewOutcome;
  totalChunks: number;
  round: number;
  earlier: string[];
  repeated: boolean;
  /** The rounds are spent: the lead lands or parks the chunk, or it is set aside. */
  final?: boolean;
  /** The tree the chunk is built in: where the decision is recorded. */
  projectDir: string;
  emit: EmitFn;
  signal?: AbortSignal;
  /** Test seam. */
  ask?: typeof askLead;
}

/** Gates whose failure no decision can land a chunk past. */
const NEVER_ACCEPTED = new Set(["build-exec", "chunk-scenarios"]);

function workerReport(o: ChunkReviewOutcome): string {
  const r = o.report;
  return `STATUS: ${r.status}\nDONE_WHEN: ${r.doneWhen}\nNOTE: ${r.note || "(empty)"}\nSPEC_GAPS: ${r.specGaps || "(empty)"}`;
}

async function record(projectDir: string, chunk: ParsedChunk, text: string): Promise<void> {
  const amended = await applyAdditiveSpecAmendment(projectDir, chunk, text);
  if (amended.ok) await safeGet(() => commitSpecAmendment(projectDir, chunk));
}

/** The lead's plan for this round, or null when it gave none (the caller's rules decide). */
export async function planLeadRound(a: LeadRoundInput): Promise<LeadRoundPlan | null> {
  const { chunk, outcome } = a;
  const decision: LeadDecision | null = await (a.ask ?? askLead)(a.lead, {
    chunk: { number: chunk.number, title: chunk.title, slice: chunk.slice, doneWhen: chunk.doneWhen, scenarios: chunk.scenarios },
    totalChunks: a.totalChunks, round: a.round, finding: outcome.reasoning, workerReport: workerReport(outcome),
    earlier: a.earlier, repeated: a.repeated, maxRounds: MAX_LEAD_ROUNDS, ...(a.final ? { final: true } : {}),
  }, { signal: a.signal });
  if (!decision) {
    a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: "build lead gave no answer in time; the engine's own rules decide this round" });
    return null;
  }
  a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `build lead: ${decision.action} — ${decision.reasoning}` });
  const rebuild = (instruction: string, c: ParsedChunk = chunk): LeadRoundPlan => a.final
    ? { kind: "halt", reasoning: `Chunk ${chunk.number} spent its ${MAX_LEAD_ROUNDS} fix rounds and the build lead did not land it: ${decision.reasoning}\n\nWhat the review found:\n${outcome.reasoning}` }
    : { kind: "rebuild", chunk: c, plan: a.plan, retryReason: `${instruction}\n\nWhat the review found:\n${outcome.reasoning}` };

  switch (decision.action) {
    case "park":
      return { kind: "halt", reasoning: `The build lead needs the owner to decide: ${decision.question}` };
    case "accept": {
      const blocking = outcome.findings.find((f) => f.action !== "proceed" && NEVER_ACCEPTED.has(f.gate));
      if (blocking) {
        a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `build lead's accept refused: the ${blocking.gate} check failed, and no chunk lands past that` });
        return rebuild("The chunk cannot land while its build, tests or held-out scenarios fail. Fix what the review found.");
      }
      const left = decision.followUps ?? [];
      await record(a.projectDir, chunk, `Accepted by the build lead: ${decision.reasoning}` +
        (left.length ? `\n\nFollow-ups it left, not blocking:\n${left.map((f) => `- ${f}`).join("\n")}` : ""));
      return { kind: "land", outcome: { ...outcome, action: "proceed", reasoning: `Accepted by the build lead: ${decision.reasoning}` } };
    }
    case "narrow": {
      // Spent rounds build nothing more, so there is no narrowed contract to record.
      if (a.final) return rebuild("");
      await record(a.projectDir, chunk, `The build lead narrowed this chunk's done-when to: ${decision.doneWhen}\nWhy: ${decision.reasoning}`);
      return rebuild(`Your chunk's contract was narrowed. Done when: ${decision.doneWhen}\nMeet that; nothing beyond it is asked of this chunk.`, { ...chunk, doneWhen: decision.doneWhen! });
    }
    case "continue":
    case "fresh":
      return rebuild(decision.instruction!);
  }
}

/**
 * A fix round decided by the build's lead (advisor/lead-decisions.ts) instead
 * of the engine's fixed rules: what the lead said, turned into what the round
 * does, with the engine's own guards on it.
 *
 *   continue / fresh  rebuild with the lead's instruction and the finding
 *   accept            land the chunk; what is left goes on record as follow-ups
 *   owed              land it with a check only the owner can run on the ledger
 *   overrule          land it over a check the lead shows is wrong, on record
 *   narrow            the chunk's done-when becomes the lead's, on record; rebuild
 *   split             narrow, and what moved out becomes new chunks (split-chunks.ts)
 *   park              set the chunk aside on the owner's question
 *
 * Guarded: a chunk whose build or tests fail, or whose held-out scenarios
 * fail, never lands, whatever the lead says; the worker is sent back. An
 * unjudged scenario is not a failed one, so "owed" can land past it. A finding
 * that came back unchanged is not answered with "continue": the round goes to
 * a fresh worker. Every landing and narrowing is recorded in
 * spec/build-state.md and committed, so the decision outlives the run.
 *
 * When the chunk's rounds are spent the lead still has the last word
 * (`final`): accept, owed and overrule land it, park sets it aside on the
 * owner's question, and any answer that would build again sets it aside. The engine used to set it aside on its own
 * at the ceiling, never asking the one agent holding the whole build.
 */
import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";
import { askLead, type LeadDecision } from "../advisor/lead-decisions.js";
import type { BuildLeadRef } from "../advisor/lead-chat.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "../loop-effects.js";
import { safeGet, type EmitFn } from "./types.js";
import { appendSplitChunks } from "./split-chunks.js";
import { recordOwed } from "../failure-recovery.js";
import { refusedCommandCheck } from "../chunk-review/chunk-verdict.js";
import { renderChunkReport } from "../chunk-review/chunk-report.js";

/** Rounds a chunk may take while its lead keeps it going: a ceiling on cost,
 *  not the rule (the lead stops it sooner, or accepts, or narrows). */
export const MAX_LEAD_ROUNDS = 8;

export type LeadRoundPlan =
  /** `fresh`: a new worker, not the one that built the last round. */
  | { kind: "rebuild"; chunk: ParsedChunk; plan: ParsedPlan; retryReason: string; fresh?: boolean }
  | { kind: "land"; outcome: ChunkReviewOutcome }
  /** `parked`: held for the owner's decision, not just left unlanded. */
  | { kind: "halt"; reasoning: string; parked?: boolean };

export interface LeadRoundInput {
  /** The project the build's ledger is kept in, when the chunk is built in a worktree of it. */
  ledgerDir?: string;
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
/** Gates a chunk lands past only with the gap on record: owed to the owner, or the check overruled. */
const LANDS_ONLY_ON_RECORD = new Set(["chunk-unjudged", "build-refused"]);

async function record(projectDir: string, chunk: ParsedChunk, text: string): Promise<void> {
  const amended = await applyAdditiveSpecAmendment(projectDir, chunk, text);
  if (amended.ok) await safeGet(() => commitSpecAmendment(projectDir, chunk));
}

/** The lead's plan for this round, or null when it gave none (the caller's rules decide). */
export async function planLeadRound(a: LeadRoundInput): Promise<LeadRoundPlan | null> {
  const { chunk, outcome } = a;
  const decision: LeadDecision | null = await (a.ask ?? askLead)(a.lead, {
    chunk: { number: chunk.number, title: chunk.title, slice: chunk.slice, doneWhen: chunk.doneWhen, scenarios: chunk.scenarios },
    totalChunks: a.totalChunks, round: a.round, finding: outcome.reasoning, workerReport: renderChunkReport(outcome.report),
    earlier: a.earlier, repeated: a.repeated, maxRounds: MAX_LEAD_ROUNDS, ...(a.final ? { final: true } : {}),
  }, { signal: a.signal });
  if (!decision) {
    a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: "build lead gave no answer in time; the engine's own rules decide this round" });
    return null;
  }
  a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `build lead: ${decision.action} — ${decision.reasoning}` });
  const rebuild = (instruction: string, c: ParsedChunk = chunk, fresh = false): LeadRoundPlan => a.final
    ? { kind: "halt", reasoning: `Chunk ${chunk.number} spent its ${MAX_LEAD_ROUNDS} fix rounds and the build lead did not land it: ${decision.reasoning}\n\nWhat the review found:\n${outcome.reasoning}` }
    : { kind: "rebuild", chunk: c, plan: a.plan, retryReason: `${instruction}\n\nWhat the review found:\n${outcome.reasoning}`, ...(fresh ? { fresh } : {}) };
  /** Land the chunk on the lead's word, unless a floor holds it back. */
  const land = async (reasoning: string, onRecord: string, extra: Partial<ChunkReviewOutcome> = {}): Promise<LeadRoundPlan> => {
    const blocking = outcome.findings.find((f) => f.action !== "proceed" && NEVER_ACCEPTED.has(f.gate));
    if (blocking) {
      a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `build lead's ${decision.action} refused: the ${blocking.gate} check failed, and no chunk lands past that` });
      return rebuild("The chunk cannot land while its build, tests or held-out scenarios fail. Fix what the review found.");
    }
    const unjudged = outcome.findings.find((f) => f.action !== "proceed" && LANDS_ONLY_ON_RECORD.has(f.gate));
    if (unjudged && decision.action === "accept") {
      a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `build lead's accept refused: the held-out scenarios were never judged, so the chunk lands only with that owed or the check overruled` });
      return rebuild("The held-out scenarios have not judged this work, so it does not land as accepted. Fix what the review found.");
    }
    const left = decision.followUps ?? [];
    await record(a.projectDir, chunk, onRecord + (left.length ? `\n\nFollow-ups it left, not blocking:\n${left.map((f) => `- ${f}`).join("\n")}` : ""));
    return { kind: "land", outcome: { ...outcome, ...extra, action: "proceed", reasoning } };
  };

  switch (decision.action) {
    case "park":
      return { kind: "halt", reasoning: `The build lead needs the owner to decide: ${decision.question}`, parked: true };
    case "accept":
      return land(`Accepted by the build lead: ${decision.reasoning}`, `Accepted by the build lead: ${decision.reasoning}`);
    case "owed":
      // A build command this machine refuses goes on the owner's list once for
      // the build, so the chunks after this one are not each asked about it.
      for (const f of outcome.findings) {
        if (f.refused) recordOwed(a.ledgerDir ?? a.projectDir, { check: refusedCommandCheck(f.refused.command), why: `\`${f.refused.command}\` cannot finish on this machine (${f.refused.what}): ${decision.owedCheck}` });
      }
      return land(
        `Landed by the build lead with a check owed to the owner: ${decision.owedCheck}`,
        `Landed by the build lead with a check owed to the owner: ${decision.owedCheck}\nWhy: ${decision.reasoning}`,
        // Added to what the review's own checks could not run, never in place of it.
        { owed: [...(outcome.owed ?? []), { check: "owed by the build lead", why: `a check is owed to the owner: ${decision.owedCheck}` }] },
      );
    case "overrule": {
      const checks = [...new Set(outcome.findings.filter((f) => f.action !== "proceed").map((f) => f.gate))].join(", ") || "review";
      a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `engine check overruled by the build lead (${checks}): ${decision.evidence}` });
      return land(
        `Landed by the build lead over the ${checks} check, which it found wrong: ${decision.evidence}`,
        `Engine check overruled by the build lead (${checks}).\nThe check said: ${outcome.reasoning.replace(/\s+/g, " ").slice(0, 600)}\nEvidence it is wrong: ${decision.evidence}`,
      );
    }
    case "narrow": {
      // Spent rounds build nothing more, so there is no narrowed contract to record.
      if (a.final) return rebuild("");
      await record(a.projectDir, chunk, `The build lead narrowed this chunk's done-when to: ${decision.doneWhen}\nWhy: ${decision.reasoning}`);
      return rebuild(`Your chunk's contract was narrowed. Done when: ${decision.doneWhen}\nMeet that; nothing beyond it is asked of this chunk.`, { ...chunk, doneWhen: decision.doneWhen! });
    }
    case "split": {
      if (a.final) return rebuild("");
      const added = appendSplitChunks(a.projectDir, chunk, decision.parts!);
      if (!added) return rebuild(decision.reasoning);
      await record(a.projectDir, chunk, `The build lead split this chunk. It keeps the done-when: ${decision.doneWhen}\n` +
        `Moved to new chunks: ${decision.parts!.map((p, i) => `chunk ${added[i]} (${p.title})`).join(", ")}\nWhy: ${decision.reasoning}`);
      a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: `chunk ${chunk.number} split: chunk(s) ${added.join(", ")} added to the plan` });
      return rebuild(`Your chunk's contract was narrowed; the rest moved to other chunks. Done when: ${decision.doneWhen}\nMeet that; nothing beyond it is asked of this chunk.`, { ...chunk, doneWhen: decision.doneWhen! });
    }
    case "continue":
    case "fresh": {
      // A finding that came back unchanged goes to a fresh worker, whatever was asked.
      const fresh = decision.action === "fresh" || a.repeated;
      if (decision.action === "continue" && a.repeated) {
        a.emit({ type: "push-back", chunkNumber: chunk.number, totalChunks: a.totalChunks, message: "the same finding came back, so this round goes to a fresh worker" });
      }
      return rebuild(decision.instruction!, chunk, fresh);
    }
  }
}

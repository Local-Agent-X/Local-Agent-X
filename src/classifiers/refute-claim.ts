/**
 * refuteClaim — task-agnostic verify-by-refutation on an ARBITRARY claim.
 *
 * The refutation panel (classifiers/verify-by-refutation.ts) is the codebase's
 * one multi-skeptic voting primitive, but until now it was only reachable from
 * two hardcoded gates (self-edit merge, egress). This is the general on-ramp:
 * hand it any assertion — a worker's "the task is done", a diagnostic
 * conclusion, an answer's factual claim — plus the evidence to weigh it
 * against, and it fires N independent skeptics (each hunting for a fatal flaw
 * from a distinct lens) and reports whether a strict majority could refute it,
 * WITH each refuting skeptic's one-line reason so the caller can act on WHY.
 *
 * Fail-safe direction is the CALLER's to pick (the primitive is policy-free):
 * `refuted` is true only on an affirmative majority refutation; "holds" and
 * "inconclusive" (e.g. every voter unavailable, no provider) both yield false.
 * A caller wanting fail-closed should inspect `verdict.verdict` directly.
 *
 * This module only frames a general-purpose refutation prompt + default lenses.
 * The tally lives in verify-by-refutation.ts; this never touches provider IO.
 */

import { verifyByRefutation, type RefutationVerdict } from "./verify-by-refutation.js";

const SYSTEM_PROMPT = `You are scrutinizing a CLAIM for a fatal flaw. Your job is to REFUTE it: hunt for a concrete, specific reason the claim is false, incomplete, or unsupported by the evidence provided.

Reply with EXACTLY one line, starting with YES or NO followed by a brief, specific reason.
YES = you found a concrete, specific reason the claim does NOT hold (refute it).
NO  = the claim holds up under this scrutiny.
Do not refute on vague grounds ("could be better"); only a real, nameable flaw counts as YES.`;

/** Default scrutiny angles — one skeptic per lens. */
const DEFAULT_LENSES = [
  "correctness — is the claim actually true, or is it contradicted by the evidence/context?",
  "completeness — does it satisfy the WHOLE ask, or does it quietly skip part of it?",
  "evidence — is the claim SUPPORTED by concrete evidence here, or merely asserted?",
];

export interface RefuteClaimResult {
  /** Strict-majority refutation. Caller picks the fail-safe direction. */
  refuted: boolean;
  verdict: RefutationVerdict;
  /** Human-readable tally, e.g. "2/3 skeptics refuted the claim". */
  summary: string;
  /** The refuting skeptics' one-line reasons — for an actionable message. */
  reasons: string[];
}

export async function refuteClaim(args: {
  /** The assertion under scrutiny. */
  claim: string;
  /** Evidence / context the skeptics should weigh the claim against. */
  context?: string;
  /** Override the default scrutiny angles (voter count = lenses.length). */
  lenses?: string[];
  /** Voter count when no lenses are given. */
  voters?: number;
  /** Telemetry / env-disable label. Defaults to "refute-claim". */
  category?: string;
  /** Env var to disable this specific caller (set to "0"). */
  envDisableVar?: string;
  signal?: AbortSignal;
}): Promise<RefuteClaimResult> {
  const userPrompt = args.context
    ? `CLAIM under scrutiny:\n${args.claim}\n\nEVIDENCE / CONTEXT to weigh it against:\n${args.context}`
    : `CLAIM under scrutiny:\n${args.claim}`;

  const verdict = await verifyByRefutation({
    category: args.category ?? "refute-claim",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    lenses: args.lenses ?? DEFAULT_LENSES,
    voters: args.voters,
    envDisableVar: args.envDisableVar,
    signal: args.signal,
  });

  const reasons = verdict.votes
    .filter((v) => v.refuted === true && v.reason.trim().length > 0)
    .map((v) => v.reason);

  return {
    refuted: verdict.verdict === "refuted",
    verdict,
    summary: `${verdict.refutedCount}/${verdict.voters} skeptics refuted the claim`,
    reasons,
  };
}

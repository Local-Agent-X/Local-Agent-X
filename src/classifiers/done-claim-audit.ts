/**
 * Fresh-context done-claim auditor (grok-lift pick #4 — the LLM half).
 *
 * The residual failure this targets: build-green ≠ complete. A model can leave
 * explicitly requested work undone (a live user-facing string the request said
 * to remove, a file the request named and it never touched) and still pass
 * every executable gate, because no gate re-reads the REQUEST. The
 * decorrelation lever is the same one spec-probes uses — CONTEXT control, not
 * a smarter model: the SAME active model re-reads the original request with
 * fresh eyes, seeing ONLY the request and the actual changes (diff or final
 * file contents) — never the conversation, so it cannot inherit the worker's
 * own rationalizations ("only comments remain") about why the work is done.
 *
 * This module ONLY renders the verdict. Evidence gathering + the nudge gate
 * live in the spec-audit gate (turn-loop), keeping this authorship advisory:
 * an unmet finding is one capped nudge, never a block or a label demotion.
 * Returns null on any failure (classifier unavailable, unparseable) → the
 * gate degrades to today's behavior.
 *
 * BIAS-TO-MET is the load-bearing design rule, inherited from the spec-probe
 * measurement history (2026-07-02: a guessed verdict that false-flags correct
 * work is worse than no check at all). The prompt confines findings to
 * requirements that are EXPLICIT in the request and VERIFIABLY unmet in the
 * shown changes; anything uncertain or out-of-view counts as met.
 *
 * Verdict shape: the schema root is the OBJECT {"unmet": string[]} rather
 * than a bare array. The old MET / "UNMET: <items>" line protocol maps 1:1
 * onto it ({"unmet":[]} = MET) with the caller contract unchanged —
 * [] = everything met, items = unmet findings, null = no verdict — and an
 * object root gives the model one unambiguous shape instead of two spellings.
 */

import { z } from "zod";
import { classifySchema, type ClassifySchemaOptions } from "./schema-output.js";

const SYSTEM_PROMPT = `You are auditing a coding agent's "done" claim with fresh eyes. You receive the user's original REQUEST and the CHANGES the agent made (a unified diff, or final file contents). The agent's conversation and reasoning are deliberately hidden from you.

Your ONLY job: list requirements that are BOTH (a) explicitly stated in the request AND (b) verifiably unmet in the changes shown.

HARD RULES:
- Judge against the request's own words only. Never invent requirements, improvements, style opinions, or best practices the request did not state.
- An item is unmet only when the shown changes PROVE it — e.g. the request says to remove every occurrence of something and one is still visible in the shown content; the request names a concrete change and the diff shows it contradicted.
- If evidence for a requirement could live in files you cannot see, or you are at all unsure, treat it as MET. A false alarm is worse than a miss.
- Requirements about running, testing, verifying, or committing are OUT of scope — other gates own those. Judge WHAT was changed, not process.
- Report the "unmet" list: EMPTY when everything explicit is met; otherwise at most 5 entries, each quoting the request phrase and one short clause of visible evidence.`;

/** Chars of request/evidence forwarded to the auditor — head-truncated by the
 *  caller; these are the hard ceilings the prompt budget is sized for. */
export const AUDIT_REQUEST_LIMIT = 6_000;
export const AUDIT_EVIDENCE_LIMIT = 14_000;

const MAX_FINDINGS = 5;

// Object root; the caller unwraps to the string[] the gate consumes.
// (classifySchema types its schema input=output, so the tidy-up below stays
// out of the schema.) Whitespace-only entries are dropped — the old line
// parser skipped blank lines — and the list is capped at MAX_FINDINGS: an
// over-long list is truncated, not rejected, mirroring the old slice.
const AuditReplySchema = z.object({ unmet: z.array(z.string()) });

function tidyFindings(unmet: string[]): string[] {
  return unmet
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_FINDINGS);
}

/**
 * One clean-context audit of the changes against the original request.
 * Returns [] when everything explicit is met, the unmet items otherwise,
 * or null when no verdict could be obtained (disabled / provider down /
 * unparseable reply) — the caller must treat null as "gate is a no-op".
 */
export async function auditDoneClaim(input: {
  userRequest: string;
  /** Unified diff of the op's edits, or labeled final file contents. */
  evidence: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  _llm?: ClassifySchemaOptions<unknown>["_llm"];
}): Promise<string[] | null> {
  const request = input.userRequest.trim().slice(0, AUDIT_REQUEST_LIMIT);
  const evidence = input.evidence.trim().slice(0, AUDIT_EVIDENCE_LIMIT);
  if (request.length < 12 || evidence.length === 0) return null;

  const reply = await classifySchema({
    category: "spec-audit",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `ORIGINAL REQUEST:\n${request}\n\n` +
      `CHANGES THE AGENT MADE:\n${evidence}\n\n` +
      `Audit now. Remember: explicit-and-proven only; when unsure, MET.`,
    schema: AuditReplySchema,
    shapeHint: `{"unmet":["\\"quoted request phrase\\" — short visible-evidence clause"]}`,
    maxResponseChars: 4_000,
    // The auditor is the ACTIVE (reasoning) model — verdict QUALITY is the
    // point, and the gate only fires at a done-claim where latency is
    // acceptable. Same trade as oracle-probe-gen.
    modelTier: "active",
    timeoutMs: input.timeoutMs ?? 40_000,
    envDisableVar: "LAX_SPEC_AUDIT",
    signal: input.signal,
    _llm: input._llm,
  });
  return reply ? tidyFindings(reply.unmet) : null;
}

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
 */

import { classifyWithLLM } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You are auditing a coding agent's "done" claim with fresh eyes. You receive the user's original REQUEST and the CHANGES the agent made (a unified diff, or final file contents). The agent's conversation and reasoning are deliberately hidden from you.

Your ONLY job: list requirements that are BOTH (a) explicitly stated in the request AND (b) verifiably unmet in the changes shown.

HARD RULES:
- Judge against the request's own words only. Never invent requirements, improvements, style opinions, or best practices the request did not state.
- An item is unmet only when the shown changes PROVE it — e.g. the request says to remove every occurrence of something and one is still visible in the shown content; the request names a concrete change and the diff shows it contradicted.
- If evidence for a requirement could live in files you cannot see, or you are at all unsure, treat it as MET. A false alarm is worse than a miss.
- Requirements about running, testing, verifying, or committing are OUT of scope — other gates own those. Judge WHAT was changed, not process.
- Output EXACTLY one of:
  - the single word MET
  - the word UNMET: followed by a numbered list (at most 5 lines), each line quoting the request phrase and one short clause of visible evidence.
No other prose.`;

/** Chars of request/evidence forwarded to the auditor — head-truncated by the
 *  caller; these are the hard ceilings the prompt budget is sized for. */
export const AUDIT_REQUEST_LIMIT = 6_000;
export const AUDIT_EVIDENCE_LIMIT = 14_000;

const MAX_FINDINGS = 5;

/**
 * Extract the unmet-requirement list from the auditor's reply.
 *   - "MET"                → []   (audited, nothing unmet)
 *   - "UNMET:" + ≥1 items  → the items (capped)
 *   - anything else        → null (no verdict — fail open, never guess)
 * Exported for direct unit testing.
 */
export function parseAuditVerdict(raw: string): string[] | null {
  const s = raw.trim().replace(/^```[a-z0-9]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  if (!s) return null;
  if (/^MET\b/i.test(s)) return [];
  const m = s.match(/^UNMET:?\s*/i);
  if (!m) return null;
  const items = s
    .slice(m[0].length)
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim())
    .filter((l) => l.length > 0);
  if (items.length === 0) return null; // "UNMET" with no findings is no verdict
  return items.slice(0, MAX_FINDINGS);
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
}): Promise<string[] | null> {
  const request = input.userRequest.trim().slice(0, AUDIT_REQUEST_LIMIT);
  const evidence = input.evidence.trim().slice(0, AUDIT_EVIDENCE_LIMIT);
  if (request.length < 12 || evidence.length === 0) return null;

  return classifyWithLLM<string[]>({
    category: "spec-audit",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `ORIGINAL REQUEST:\n${request}\n\n` +
      `CHANGES THE AGENT MADE:\n${evidence}\n\n` +
      `Audit now. Remember: explicit-and-proven only; when unsure, MET.`,
    parse: parseAuditVerdict,
    maxResponseChars: 4_000,
    // The auditor is the ACTIVE (reasoning) model — verdict QUALITY is the
    // point, and the gate only fires at a done-claim where latency is
    // acceptable. Same trade as oracle-probe-gen.
    modelTier: "active",
    timeoutMs: input.timeoutMs ?? 40_000,
    envDisableVar: "LAX_SPEC_AUDIT",
    signal: input.signal,
  });
}

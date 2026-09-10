/**
 * Fresh-context regression auditor — the LLM half of the regression-audit
 * completion gate (turn-loop/regression-audit.ts).
 *
 * Sibling to done-claim-audit.ts, NOT a variant of it: that module answers
 * "did the diff satisfy the explicit REQUEST?" (completeness). This one
 * answers a different question a completeness check structurally cannot ask —
 * "did the diff introduce a concrete regression or risk nothing in the
 * request would ever mention?" Motivated by the 2026-09-09 CRM job-segments
 * incident: build + the model's own tests were green, spec-audit had nothing
 * to flag (the request was satisfied), yet the diff silently broke an
 * untouched page's query behavior, leaked payment data behind client-side-only
 * masking, added a catch block that misattributed real failures, and weakened
 * two test assertions to make its own suite pass. A human only caught it by
 * manually switching to a second model and asking it to audit the diff cold.
 *
 * Same fresh-context lever as done-claim-audit (conversation hidden,
 * diff-only) and the same BIAS-TO-NO-FINDING posture (spec-probes' measured
 * lesson: a false flag on correct work is worse than a miss). This module
 * only renders the verdict; evidence gathering (including the blast-radius
 * consumer grep) and the nudge gate live in turn-loop/regression-audit.ts.
 * Returns null on any failure — the gate degrades to a no-op.
 */

import { z } from "zod";
import { classifySchema, type ClassifySchemaOptions } from "./schema-output.js";

const SYSTEM_PROMPT = `You are auditing a coding agent's finished, "done" change for regressions its own tests and build did not catch. You receive the CHANGES (a unified diff, or final file contents) and, when available, a list of OTHER FILES in the codebase that reference something the diff changed but were NOT part of the diff. The agent's conversation and reasoning are deliberately hidden from you.

Your ONLY job: flag CONCRETE, VERIFIABLE risks in these four categories:
1. CONSUMER BREAKAGE — the diff changes the behavior (not just the shape) of a shared function/query/table, and a listed other-file consumer's use of it is now inconsistent with the new behavior (e.g. a filter narrowed, a return shape changed, a field removed, a case no longer handled).
2. DATA EXPOSURE — a field carrying money, pricing, payment, secret, token, or credential data is sent to a client / less-privileged surface without server-side filtering (hidden in the UI only, or a sanitizer that doesn't strip every sensitive field on that path).
3. ERROR-HANDLING THAT MASKS FAILURES — a catch block treats unrelated failure types the same way, or routes a caught failure to code for the wrong entity/resource, so a real error is silently misreported or misattributed.
4. WEAKENED TESTS — a test assertion in the diff is looser than the code it exists to guard (accepts a range of outcomes where only one is correct, treats a missing fixture as success, or tests a helper instead of the actual integration point the change touches).

HARD RULES:
- Only flag what the shown evidence PROVES. Never invent risk from missing context, style opinions, or best practices the evidence doesn't establish.
- If evidence for or against a risk could live in a file you cannot see, or you are at all unsure, do NOT flag it. A false alarm is worse than a miss.
- The "other files" list, when present, is NOT itself proof of breakage — it only tells you where to look. Flag consumer breakage only when the diff's own behavior change is visible AND the listed file's usage is shown to conflict with it.
- Report the "findings" list: EMPTY when nothing concrete surfaces; otherwise at most 5 entries, each one sentence naming the category, the file, and the concrete evidence.`;

/** Chars of evidence forwarded to the auditor — the caller head-truncates to this. */
export const AUDIT_EVIDENCE_LIMIT = 14_000;

const MAX_FINDINGS = 5;

const RegressionReplySchema = z.object({ findings: z.array(z.string()) });

function tidyFindings(findings: string[]): string[] {
  return findings
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_FINDINGS);
}

export interface RegressionAuditProviderOverride {
  provider: string;
  apiKey: string;
  model: string;
}

/**
 * One clean-context audit of the diff for regression risk. Returns [] when
 * nothing concrete surfaces, the findings otherwise, or null when no verdict
 * could be obtained (disabled / provider down / unparseable reply) — the
 * caller must treat null as "gate is a no-op".
 */
export async function auditRegressionRisk(input: {
  /** Unified diff of the op's edits, or labeled final file contents. */
  evidence: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Opt-in second-provider audit target — see resolve-regression-audit-provider.ts. Undefined = same-model. */
  providerOverride?: RegressionAuditProviderOverride;
  _llm?: ClassifySchemaOptions<unknown>["_llm"];
}): Promise<string[] | null> {
  const evidence = input.evidence.trim().slice(0, AUDIT_EVIDENCE_LIMIT);
  if (evidence.length === 0) return null;

  const reply = await classifySchema({
    category: "regression-audit",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `CHANGES THE AGENT MADE:\n${evidence}\n\n` +
      `Audit now. Remember: concrete-and-proven only; when unsure, do not flag.`,
    schema: RegressionReplySchema,
    shapeHint: `{"findings":["category — file — one-sentence evidence"]}`,
    maxResponseChars: 4_000,
    // Same trade as done-claim-audit: verdict QUALITY is the point, and this
    // only fires at a done-claim where latency is acceptable.
    modelTier: "active",
    timeoutMs: input.timeoutMs ?? 45_000,
    envDisableVar: "LAX_REGRESSION_AUDIT",
    signal: input.signal,
    providerOverride: input.providerOverride,
    _llm: input._llm,
  });
  return reply ? tidyFindings(reply.findings) : null;
}

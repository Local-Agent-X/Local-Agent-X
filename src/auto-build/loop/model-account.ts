/**
 * A worker whose model account refused the request: out of credits, or not
 * signed in. Nothing the build does can change that, and every other chunk
 * would fail the same way, so the build stops once and says what to fix.
 *
 * Shop Helper's Grok account ran out of credits mid-build (2026-11-27): the
 * failure read as "agent failed before producing a report", chunks 2 and 3
 * went through retries and were set aside, and the owner learned of it from
 * the halt history.
 */
import { normalizeRuntimeFailure } from "../../canonical-loop/public/runtime-failure.js";
import type { ChunkReviewOutcome } from "../chunk-review/index.js";

const ACCOUNT_FAILURES: ReadonlySet<string> = new Set(["billing", "auth"]);

/** Why the model account cannot run a worker, from the worker's error; null when the error is something else. */
export function modelAccountProblem(error: string | undefined): string | null {
  const text = (error ?? "").trim();
  if (!text) return null;
  const kind = normalizeRuntimeFailure("", text);
  if (!kind || !ACCOUNT_FAILURES.has(kind)) return null;
  const what = kind === "billing" ? "is out of credits or has no active plan" : "is not signed in, or its sign-in was refused";
  return `The model account this build runs on ${what}, so no worker can run. Fix the account, then Resume: the build goes on from where it stopped. What the provider said: ${text.replace(/\s+/g, " ").slice(0, 300)}`;
}

/** The outcome's model-account stop, in its own words; null when it has none. */
export function modelAccountStop(outcome: Pick<ChunkReviewOutcome, "findings">): string | null {
  return outcome.findings.find((f) => f.gate === "model-account")?.reasoning ?? null;
}

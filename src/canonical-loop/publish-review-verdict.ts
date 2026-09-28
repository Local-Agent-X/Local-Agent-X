/**
 * The pre-publish review's vocabulary: its op type, the outcome the gate acts
 * on, and the STRICT parser for the reviewer's answer.
 *
 * Strict because the gate blocks on it. The reviewer must answer
 *
 *     VERDICT: RED|AMBER|GREEN
 *     SEVERITY | path:line | problem | why it matters | fix
 *     ...
 *
 * and anything else — a missing or malformed verdict line, a line that is not
 * a well-formed finding, an empty answer — is FAILED, never GREEN. A lenient
 * parser that skipped an unrecognized line could skip the one red finding that
 * was written slightly off-format. The verdict is also never LOWER than the
 * worst finding: "VERDICT: GREEN" above a red finding is RED.
 *
 * Light on purpose (no imports): verification-trigger.ts reads the op type for
 * its recursion guard on every terminal event.
 */

/** The review op's type — the persisted marker the recursion guards key on.
 *  Dispatch is not type-keyed (runtime.ts resolves adapters per op id). */
export const REVIEW_PUBLISH_OP_TYPE = "review_publish";

export type ReviewSeverity = "red" | "amber" | "yellow";
export type ReviewVerdict = "RED" | "AMBER" | "GREEN";

export interface ReviewFinding {
  severity: ReviewSeverity;
  /** path:line as the reviewer wrote it. */
  location: string;
  problem: string;
  why: string;
  fix: string;
}

/**
 * What the gate knows about a publish:
 *   RED / AMBER / GREEN  the reviewer's verdict
 *   FAILED               a review ran but produced no usable verdict (timeout,
 *                        provider failure, unparseable answer) — never a pass
 *   UNKNOWN              what would ship could not be determined, so nothing
 *                        was reviewed
 *   EMPTY                nothing new would ship; no review was needed
 */
export type PublishReviewStatus = ReviewVerdict | "FAILED" | "UNKNOWN" | "EMPTY";

export interface PublishReview {
  status: PublishReviewStatus;
  findings: ReviewFinding[];
  /** FAILED / UNKNOWN: why there is no verdict. */
  reason?: string;
  /** The review op, when one ran. */
  opId?: string;
  /** Change-set fingerprint the verdict belongs to. */
  fingerprint: string;
  /** One line: what was reviewed. */
  summary: string;
  /** Publishing commands whose change set could not be determined. */
  unknown: Array<{ label: string; reason: string }>;
  /** Served from the per-session cache rather than a fresh review. */
  cached?: boolean;
}

export type ParsedReview =
  | { ok: true; verdict: ReviewVerdict; findings: ReviewFinding[] }
  | { ok: false; reason: string };

const VERDICT_LINE = /^VERDICT:\s*(RED|AMBER|GREEN)$/;
const RANK: Record<ReviewSeverity, number> = { yellow: 0, amber: 1, red: 2 };
const VERDICT_FOR_RANK: ReviewVerdict[] = ["GREEN", "AMBER", "RED"];

export function parseReviewAnswer(text: string): ParsedReview {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    // A fenced answer is the same answer; the fence lines carry nothing.
    .filter((l) => l && !/^```\w*$/.test(l));
  if (lines.length === 0) return { ok: false, reason: "the reviewer returned no answer" };
  const head = VERDICT_LINE.exec(lines[0]);
  if (!head) return { ok: false, reason: `the reviewer's first line is not "VERDICT: RED|AMBER|GREEN" (got: ${lines[0].slice(0, 80)})` };
  const findings: ReviewFinding[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim());
    const severity = cells[0]?.toLowerCase();
    if (cells.length !== 5 || !(severity === "red" || severity === "amber" || severity === "yellow") || cells.some((c) => !c)) {
      return { ok: false, reason: `line ${i + 1} of the reviewer's answer is not a finding (SEVERITY | path:line | problem | why it matters | fix): ${lines[i].slice(0, 80)}` };
    }
    findings.push({ severity, location: cells[1], problem: cells[2], why: cells[3], fix: cells[4] });
  }
  const stated = VERDICT_FOR_RANK.indexOf(head[1] as ReviewVerdict);
  const worst = findings.reduce((max, f) => Math.max(max, RANK[f.severity]), 0);
  return { ok: true, verdict: VERDICT_FOR_RANK[Math.max(stated, worst)], findings };
}

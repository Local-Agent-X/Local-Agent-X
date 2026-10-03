/**
 * How a publish review reads — to the model (tool results), to the user (the
 * approval card's context line and its typed preview). Pure formatting.
 *
 * One rule runs through all of it: FAILED, UNKNOWN and EMPTY are never worded
 * as a pass. The model and the user are told plainly when nothing was reviewed.
 */
import type { ActionPreview } from "../types.js";
import type { PublishOperation } from "../publish-operation.js";
import type { PublishReview, ReviewFinding } from "../canonical-loop/public/publish-review.js";

function findingLine(f: ReviewFinding): string {
  return `- [${f.severity}] ${f.location}: ${f.problem} — ${f.why}. Fix: ${f.fix}`;
}

function counts(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "no findings";
  const by = (s: ReviewFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  const parts = (["red", "amber", "yellow"] as const).filter((s) => by(s) > 0).map((s) => `${by(s)} ${s}`);
  return `${findings.length} finding${findings.length === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/** One line: the status and what it covered. */
export function reviewHeadline(review: PublishReview): string {
  switch (review.status) {
    case "RED":
    case "AMBER":
    case "GREEN":
      return `${review.status} — ${counts(review.findings)} in ${review.summary}${review.cached ? " (verdict reused: the change set is identical)" : ""}`;
    case "FAILED":
      return `FAILED — ${review.reason ?? "no usable verdict"}. This publish was NOT reviewed.`;
    case "UNKNOWN":
      return `UNKNOWN — what would ship could not be determined, so NOTHING was reviewed: ${review.unknown.map((u) => `${u.label}: ${u.reason}`).join("; ")}`;
    case "EMPTY":
      return `nothing new would ship (${review.summary}); no review was needed`;
  }
}

const notReviewed = (review: PublishReview): string => review.unknown.map((u) => `${u.label} (${u.reason})`).join("; ");

function unknownTail(review: PublishReview): string {
  if (review.status === "UNKNOWN" || review.unknown.length === 0) return "";
  return `\nNot reviewed: ${notReviewed(review)}`;
}

/** A verdict that covers only part of the call: the rest could not be reviewed. */
const partlyReviewed = (review: PublishReview): boolean =>
  (review.status === "AMBER" || review.status === "GREEN") && review.unknown.length > 0;

/** The note the model reads on a publish that ran. */
export function reviewNoteForModel(review: PublishReview): string {
  const lines = [`[pre-publish review: ${reviewHeadline(review)}]`];
  for (const f of review.findings) lines.push(findingLine(f));
  if (review.status === "AMBER") lines.push("Tell the user about the amber findings and offer to fix them.");
  return lines.join("\n") + unknownTail(review);
}

/** A verdict the user must answer for in every profile: a red finding, no
 *  review at all, or a publish in the same call that could not be reviewed —
 *  otherwise one reviewable push in front would carry an unreviewable one out
 *  on the first push's verdict. Nothing ships over any of them without their
 *  explicit yes. */
export function needsOverride(review: PublishReview): boolean {
  return review.status === "RED" || review.status === "FAILED" || review.status === "UNKNOWN" || review.unknown.length > 0;
}

export type StopReason = "unattended" | "declined" | "unanswered" | "no-channel";

/** What the model reads when the review stopped the publish: a RED verdict, a
 *  review that could not run, or a publish in the call that could not be
 *  reviewed, and the user did not override it. */
export function stopText(op: PublishOperation, review: PublishReview, how: StopReason): string {
  const anyway = review.status === "RED" ? "publish anyway" : "publish unreviewed";
  const why = how === "declined"
    ? `The user saw this and chose not to ${anyway}.`
    : how === "unanswered"
      ? `The user was asked whether to ${anyway} and did not answer.`
      : how === "no-channel"
        ? "Nobody can be asked to override it on this dispatch."
        : "This is an unattended run, so nobody can override it.";
  if (partlyReviewed(review)) {
    return [
      `NOT RUN: this ${op.tool} call was stopped because part of what it publishes could not be reviewed: ${notReviewed(review)}. ${why}`,
      `The rest was reviewed: ${reviewHeadline(review)}`,
      ...review.findings.map(findingLine),
      "Nothing ships unreviewed without the user's explicit approval. Fix what stopped that part's review, or publish the reviewed part on its own, or tell the user what happened and let them decide. Do not publish by another route.",
    ].join("\n");
  }
  if (review.status !== "RED") {
    return [
      `NOT RUN: ${op.label} was stopped because the pre-publish review could not run (${reviewHeadline(review)}). ${why}`,
      "Nothing ships unreviewed without the user's explicit approval. Fix what stopped the review (a repository or remote git cannot reach, a review that timed out) and publish again, or tell the user what happened and let them decide. Do not publish by another route.",
    ].join("\n");
  }
  return [
    `NOT RUN: ${op.label} was stopped by the pre-publish review (verdict RED). ${why}`,
    `Reviewed: ${review.summary}`,
    "Findings:",
    ...review.findings.map(findingLine),
    "Fix every red finding, commit, and publish again — the changed diff gets a fresh review. Do not publish by another route, and tell the user what was found.",
  ].join("\n") + unknownTail(review);
}

/** The word on the override button: what the user is overriding — a red
 *  finding ("Push anyway") or the absence of a review ("Push unreviewed"). */
export function overrideLabel(op: PublishOperation, review: PublishReview): string {
  const how = review.status === "RED" ? "anyway" : "unreviewed";
  switch (op.kind) {
    case "git-push": return `Push ${how}`;
    case "deploy": return `Deploy ${how}`;
    case "package-publish": return `Publish ${how}`;
    case "release": return op.label.startsWith("gh pr merge") ? `Merge ${how}` : `Release ${how}`;
  }
}

/** The card's context line. */
export function reviewCardContext(op: PublishOperation, review: PublishReview, base: string): string {
  if (review.status === "RED") {
    return `⛔ The pre-publish review found problems that should block ${op.label}. "${overrideLabel(op, review)}" overrides it and is recorded. ${review.summary}`;
  }
  if (partlyReviewed(review)) {
    return `⚠ Part of what this call publishes was not reviewed: ${notReviewed(review)}. The rest: ${reviewHeadline(review)}. "${overrideLabel(op, review)}" runs all of it, the unreviewed part included, and is recorded.`;
  }
  if (needsOverride(review)) {
    return `⚠ Nothing was reviewed: ${reviewHeadline(review)}. "${overrideLabel(op, review)}" sends ${op.label} without a review and is recorded.`;
  }
  return `Pre-publish review: ${reviewHeadline(review)}. ${base}`.trim();
}

/** The typed card preview (public/js renders it). */
export function reviewPreview(op: PublishOperation, review: PublishReview): ActionPreview {
  return {
    kind: "publish-review",
    status: review.status,
    command: op.command ?? op.label,
    summary: review.summary,
    findings: review.findings,
    ...(review.reason ? { reason: review.reason } : {}),
    ...(review.unknown.length ? { unknown: review.unknown } : {}),
    ...(needsOverride(review) ? { overrideLabel: overrideLabel(op, review) } : {}),
  };
}

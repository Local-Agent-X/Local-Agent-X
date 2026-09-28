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

function unknownTail(review: PublishReview): string {
  if (review.status === "UNKNOWN" || review.unknown.length === 0) return "";
  return `\nNot reviewed: ${review.unknown.map((u) => `${u.label} (${u.reason})`).join("; ")}`;
}

/** The note the model reads on a publish that ran. */
export function reviewNoteForModel(review: PublishReview): string {
  const lines = [`[pre-publish review: ${reviewHeadline(review)}]`];
  for (const f of review.findings) lines.push(findingLine(f));
  if (review.status === "AMBER") lines.push("Tell the user about the amber findings and offer to fix them.");
  return lines.join("\n") + unknownTail(review);
}

/** What the model reads when a RED review stopped the publish. */
export function redBlockText(op: PublishOperation, review: PublishReview, how: "unattended" | "declined" | "unanswered" | "no-channel"): string {
  const why = how === "declined"
    ? "The user saw the findings and chose not to publish anyway."
    : how === "unanswered"
      ? "The user was asked whether to publish anyway and did not answer."
      : how === "no-channel"
        ? "Nobody can be asked to override it on this dispatch."
        : "This is an unattended run, so nobody can override it.";
  return [
    `NOT RUN: ${op.label} was stopped by the pre-publish review (verdict RED). ${why}`,
    `Reviewed: ${review.summary}`,
    "Findings:",
    ...review.findings.map(findingLine),
    "Fix every red finding, commit, and publish again — the changed diff gets a fresh review. Do not publish by another route, and tell the user what was found.",
  ].join("\n") + unknownTail(review);
}

/** The word on the override button: what the user is overriding. */
export function overrideLabel(op: PublishOperation): string {
  switch (op.kind) {
    case "git-push": return "Push anyway";
    case "deploy": return "Deploy anyway";
    case "package-publish": return "Publish anyway";
    case "release": return op.label.startsWith("gh pr merge") ? "Merge anyway" : "Release anyway";
  }
}

/** The card's context line. */
export function reviewCardContext(op: PublishOperation, review: PublishReview, base: string): string {
  if (review.status === "RED") {
    return `⛔ The pre-publish review found problems that should block ${op.label}. "${overrideLabel(op)}" overrides it and is recorded. ${review.summary}`;
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
    ...(review.status === "RED" ? { overrideLabel: overrideLabel(op) } : {}),
  };
}

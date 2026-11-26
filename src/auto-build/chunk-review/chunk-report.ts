/**
 * What a chunk's worker reported, as the review reads it.
 *
 * The worker ends its run by calling `chunk_report` (agents/report-tools.ts),
 * whose arguments are checked when it calls. Nothing here parses text: the
 * report used to be a block of STATUS / DONE_WHEN / NEW_FAILURES lines read
 * with regexes, and every phrasing a model reached for was a new bug.
 *
 * What the report can decide is small on purpose. The engine measures whether
 * the code builds, passes its tests, meets its held-out scenarios and survives
 * the skeptic; the files the chunk changed are read from git. The report says
 * what only the worker knows: that it stopped and why, what could not be shown
 * on this machine, what the spec left open. A worker that reported nothing is
 * not sent back for that: its work is measured like any other.
 */
import type { ChunkReportCall } from "../agents/agent-report.js";

export type ReportStatus = "done" | "blocked" | "partial" | "unknown";
export type ReportDoneWhen = "met" | "deferred-to-launch-readiness" | "unmet" | "unknown";

export interface ChunkReport {
  /** `unknown`: the worker made no report. */
  status: ReportStatus;
  doneWhen: ReportDoneWhen;
  /** Files the chunk changed since it started, read from git, never self-reported. */
  changed: string[];
  specGaps: string;
  /** What could not be shown on this machine, one line each with how to verify it; "" when none. */
  launchReadiness: string;
  note: string;
  /** Commands the worker says this machine refused to run. */
  machineBlocked: { check: string; reason: string }[];
  /** A choice only the owner can make, as the worker put it; "" when none. */
  ownerQuestion: string;
  /** Whether the worker called `chunk_report` at all. */
  reported: boolean;
}

/** The review's reading of what the worker delivered, with the files git says the chunk changed. */
export function chunkReportOf(call: ChunkReportCall | undefined, changed: readonly string[] = []): ChunkReport {
  if (!call) {
    return { status: "unknown", doneWhen: "unknown", changed: [...changed], specGaps: "", launchReadiness: "", note: "", machineBlocked: [], ownerQuestion: "", reported: false };
  }
  return {
    status: call.status,
    doneWhen: call.doneWhen === "deferred" ? "deferred-to-launch-readiness" : call.doneWhen,
    changed: [...changed],
    specGaps: call.specGaps,
    launchReadiness: call.launchReadiness.map((r) => `${r.what}: ${r.howToVerify}`).join("\n"),
    note: call.note,
    machineBlocked: call.machineBlocked,
    ownerQuestion: call.ownerQuestion,
    reported: true,
  };
}

/** The report in a few labelled lines, for a reader that judges it: the
 *  skeptic (its claim under attack), the build's lead, the push-back advisor. */
export function renderChunkReport(report: ChunkReport): string {
  if (!report.reported) return "(the worker made no report)";
  return [
    `Status: ${report.status}; done-when: ${report.doneWhen}`,
    `Note: ${report.note || "(none)"}`,
    report.specGaps && `Spec gaps: ${report.specGaps}`,
    report.launchReadiness && `Could not be shown on this machine:\n${report.launchReadiness}`,
    report.machineBlocked.length > 0 && `This machine refused: ${report.machineBlocked.map((b) => `\`${b.check}\` (${b.reason})`).join("; ")}`,
    report.ownerQuestion && `Question for the owner: ${report.ownerQuestion}`,
  ].filter(Boolean).join("\n");
}

/** The worker's own words, to travel with a push-back reason: without them the
 *  reason is just "the worker reports blocked", and the blocker itself lives
 *  only in a finished agent's session. "" when the report carries none. */
export function workerWords(report: ChunkReport): string {
  const parts = [
    report.note && `Note: ${report.note}`,
    report.specGaps && `Spec gaps: ${report.specGaps}`,
    report.ownerQuestion && `Question for the owner: ${report.ownerQuestion}`,
  ].filter(Boolean);
  return parts.length ? ` The worker's report: ${parts.join(" | ").slice(0, 1200)}` : "";
}

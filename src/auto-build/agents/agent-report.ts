/**
 * How a build agent's report reaches the engine: a typed tool call, not text.
 *
 * A worker, a skeptic and a break-it agent each ended their run with a block
 * of text the engine parsed with regexes (STATUS / NEW_FAILURES, VERDICT /
 * GROUND, FINDINGS). Every phrasing a model reached for was a new bug:
 * "NEW_FAILURES: none observed" read as one failing test and set a fix aside
 * with no fix round (label-check-sol, 2026-11-25), a skeptic's answer with no
 * VERDICT line read as BROKEN, a break-it finding that did not match
 * `- [severity] text` was dropped without a word.
 *
 * Now each ends by calling its report tool (report-tools.ts), whose arguments
 * the tool checks and the model can correct. The engine opens a slot for the
 * run before it starts (runChunkAgent knows the run's session then) and takes
 * what was delivered when the run ends, however it ends. The lead's
 * `build_decide` works the same way (advisor/lead-decisions.ts).
 *
 * The slots live in this process. A run that offers a report tool is kept in
 * it: the tools are registered by a plugin (tools/plugins.ts), which an op
 * moved to a worker process cannot rebuild.
 */

export interface ChunkReportCall {
  status: "done" | "blocked" | "partial";
  doneWhen: "met" | "deferred" | "unmet";
  /** What was built and how it was shown to work, in the worker's words. */
  note: string;
  /** A rule the spec does not state that the work had to assume. */
  specGaps: string;
  /** Checks that need something this machine does not have, each with how to make them. */
  launchReadiness: { what: string; howToVerify: string }[];
  /** Commands this machine itself would not run, each with what it printed. */
  machineBlocked: { check: string; reason: string }[];
  /** A choice of product, money, risk or taste only the owner can make. */
  ownerQuestion: string;
}

export interface SkepticVerdictCall {
  verdict: "holds" | "broken";
  /** broken: the ground it breaks, as the brief words or numbers it. */
  ground: string;
  /** broken: what breaks and how it was shown. holds: what was tried. */
  finding: string;
  /** What it found beyond the chunk's contract: recorded, never blocking. */
  followUps: string[];
}

export interface BreakerFindingsCall {
  findings: { severity: "critical" | "high" | "medium" | "low"; text: string; reach: "reachable" | "unreachable"; reachWhy: string }[];
}

interface Reports { chunk: ChunkReportCall; skeptic: SkepticVerdictCall; breaker: BreakerFindingsCall }
export type ReportKind = keyof Reports;

const slots = new Map<string, { kind: ReportKind; report?: unknown }>();

/** Wait for `sessionId`'s report: called before the run can make it. */
export function openReportSlot(sessionId: string, kind: ReportKind): void {
  slots.set(sessionId, { kind });
}

/** The report the run delivered, if any; the slot is closed either way. */
export function takeReport<K extends ReportKind>(sessionId: string, kind: K): Reports[K] | undefined {
  const slot = slots.get(sessionId);
  slots.delete(sessionId);
  return slot?.kind === kind ? (slot.report as Reports[K] | undefined) : undefined;
}

/**
 * Deliver a checked report for the calling session. Returns null when it was
 * taken, or what to tell the caller: no build is waiting on this session (the
 * main chat, a run already cancelled), or it is waiting on another kind of
 * report. A second call replaces the first: the last word is the report.
 */
export function deliverReport<K extends ReportKind>(sessionId: string | undefined, kind: K, report: Reports[K]): string | null {
  const slot = sessionId ? slots.get(sessionId) : undefined;
  if (!slot) return "No build is waiting for a report from this session, so nothing was recorded.";
  if (slot.kind !== kind) return `This run reports with its ${slot.kind} report tool, not this one.`;
  slot.report = report;
  return null;
}

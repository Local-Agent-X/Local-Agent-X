/**
 * The report tools a build agent ends its run with (agent-report.ts): the
 * worker's `chunk_report`, the skeptic's `skeptic_verdict`, a break-it agent's
 * `breaker_findings`. Each checks its arguments and says what is wrong with
 * them, so the model corrects the call: the engine never guesses at a report.
 *
 * The dispatcher checks only top-level required fields, types and enums
 * (tool-execution/arg-validation.ts); what is inside a list, and what
 * contradicts what, is checked here.
 */
import type { ToolDefinition, ToolResult } from "../../types.js";
import { sessionIdOf } from "../../tool-execution/internal-args.js";
import { deliverReport, type BreakerFindingsCall, type ChunkReportCall, type ReportKind, type SkepticVerdictCall } from "./agent-report.js";

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
type Read<T> = T | { error: string };

const STATUSES = ["done", "blocked", "partial"] as const;
const DONE_WHENS = ["met", "deferred", "unmet"] as const;
const VERDICTS = ["holds", "broken"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export function readChunkReport(args: Record<string, unknown>): Read<ChunkReportCall> {
  const status = oneOf(args.status, STATUSES);
  const doneWhen = oneOf(args.done_when, DONE_WHENS);
  if (!status) return { error: `status must be one of: ${STATUSES.join(", ")}.` };
  if (!doneWhen) return { error: `done_when must be one of: ${DONE_WHENS.join(", ")}.` };
  const note = text(args.note);
  if (!note) return { error: "note is required: what you built and how you showed it works, or what stopped you." };
  if (status === "done" && doneWhen === "unmet") return { error: "status done with done_when unmet contradicts itself: say partial or blocked, or met if the done-when is met." };
  const launchReadiness = list(args.launch_readiness).map((r) => ({ what: text(r.what), howToVerify: text(r.how_to_verify) }));
  if (launchReadiness.some((r) => !r.what || !r.howToVerify)) return { error: "each launch_readiness item needs `what` (the check) and `how_to_verify` (the steps and what it needs)." };
  if (doneWhen === "deferred" && launchReadiness.length === 0) return { error: "done_when deferred needs launch_readiness: the check that could not be made here, and how to make it." };
  const machineBlocked = list(args.machine_blocked).map((r) => ({ check: text(r.check), reason: text(r.reason) }));
  if (machineBlocked.some((r) => !r.check || !r.reason)) return { error: "each machine_blocked item needs `check` (the command) and `reason` (what the machine printed)." };
  return { status, doneWhen, note, specGaps: text(args.spec_gaps), launchReadiness, machineBlocked, ownerQuestion: text(args.owner_question) };
}

export function readSkepticVerdict(args: Record<string, unknown>): Read<SkepticVerdictCall> {
  const verdict = oneOf(args.verdict, VERDICTS);
  if (!verdict) return { error: `verdict must be one of: ${VERDICTS.join(", ")}.` };
  const finding = text(args.finding);
  if (!finding) return { error: "finding is required: what breaks and how you showed it, or what you tried that held." };
  const ground = text(args.ground);
  if (verdict === "broken" && !ground) return { error: "a broken verdict needs `ground`: which ground of your brief it breaks." };
  const followUps = Array.isArray(args.follow_ups) ? args.follow_ups.map(text).filter(Boolean) : [];
  return { verdict, ground, finding, followUps };
}

export function readBreakerFindings(args: Record<string, unknown>): Read<BreakerFindingsCall> {
  if (!Array.isArray(args.findings)) return { error: "findings must be a list; an empty list when you found nothing." };
  const findings: BreakerFindingsCall["findings"] = [];
  for (const item of list(args.findings)) {
    const severity = oneOf(item.severity, SEVERITIES);
    const said = text(item.text);
    if (!severity || !said) return { error: `each finding needs \`severity\` (${SEVERITIES.join(", ")}) and \`text\` (what breaks and how you showed it).` };
    findings.push({ severity, text: said });
  }
  if (findings.length !== args.findings.length) return { error: "each finding must be an object with `severity` and `text`." };
  return { findings };
}

function reportTool<K extends ReportKind, T>(
  kind: K, name: string, description: string, parameters: ToolDefinition["parameters"],
  read: (args: Record<string, unknown>) => Read<T>,
): ToolDefinition {
  return {
    name, description, parameters,
    async execute(args): Promise<ToolResult> {
      const report = read(args);
      if (report && typeof report === "object" && "error" in report) return { content: `${report.error} Fix and call ${name} again.`, isError: true };
      const refused = deliverReport(sessionIdOf(args), kind, report as never);
      if (refused) return { content: refused, isError: true };
      return { content: "Recorded. Your run ends here." };
    },
  };
}

const str = (description: string) => ({ type: "string", description });

export const chunkReportTool = reportTool("chunk", "chunk_report",
  "End your chunk by reporting where it stands. Call it once, as the last thing you do; a second call replaces the first. " +
  "The engine builds and tests the project itself, so do not report test counts: say what you did and what you could not.",
  {
    type: "object",
    properties: {
      status: { type: "string", enum: [...STATUSES], description: "done: the work is finished. partial: some is, and you say what is not. blocked: you could not do it, and you say why." },
      done_when: { type: "string", enum: [...DONE_WHENS], description: "met: the chunk's done-when holds, shown here. deferred: it can only be shown with something this machine lacks (see launch_readiness). unmet: it does not hold yet." },
      note: str("What you built and how you showed it works, or what stopped you. A few sentences."),
      spec_gaps: str("A rule the spec does not state that you had to assume, with what you assumed. Omit when there is none."),
      launch_readiness: {
        type: "array", description: "Checks that need something this machine does not have (a phone, a paid account, production credentials).",
        items: { type: "object", properties: { what: str("The check."), how_to_verify: str("The steps to make it, and what it needs.") }, required: ["what", "how_to_verify"] },
      },
      machine_blocked: {
        type: "array", description: "Commands this machine itself refused to run (an operating-system or policy block, not a failing test), each with what it printed.",
        items: { type: "object", properties: { check: str("The command."), reason: str("What the machine printed.") }, required: ["check", "reason"] },
      },
      owner_question: str("A choice of product, money, risk or taste that only the owner can make, as one question. Omit when there is none."),
    },
    required: ["status", "done_when", "note"],
  }, readChunkReport);

export const skepticVerdictTool = reportTool("skeptic", "skeptic_verdict",
  "End your review with your verdict. Call it once, as the last thing you do; a second call replaces the first.",
  {
    type: "object",
    properties: {
      verdict: { type: "string", enum: [...VERDICTS], description: "broken: you showed a break on one of the grounds in your brief. holds: you tried and the change survived." },
      ground: str("broken: which ground of your brief it breaks (its number when the brief numbers them, then the line it breaks, quoted)."),
      finding: str("broken: what breaks and how you showed it. holds: what you tried."),
      follow_ups: { type: "array", items: { type: "string" }, description: "What you found beyond the chunk's contract: recorded for the owner, never a reason the chunk is held." },
    },
    required: ["verdict", "finding"],
  }, readSkepticVerdict);

export const breakerFindingsTool = reportTool("breaker", "breaker_findings",
  "End your attack on the app with what you found. Call it once, as the last thing you do; a second call replaces the first.",
  {
    type: "object",
    properties: {
      findings: {
        type: "array", description: "Each thing that breaks, most serious first. An empty list when nothing did.",
        items: { type: "object", properties: { severity: { type: "string", enum: [...SEVERITIES] }, text: str("What breaks and how you showed it.") }, required: ["severity", "text"] },
      },
    },
    required: ["findings"],
  }, readBreakerFindings);

export const REPORT_TOOLS: readonly ToolDefinition[] = [chunkReportTool, skepticVerdictTool, breakerFindingsTool];

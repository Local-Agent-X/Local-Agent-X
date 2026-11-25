/**
 * A figures check sized to the deliverable: the figures are listed
 * (figure-inventory.ts), a share of them is chosen (all of them when the user
 * asked), and they are checked in passes of FIGURES_PER_PASS, PASSES_AT_ONCE
 * at a time. Each pass is an ordinary verification op with its own budget, so
 * a 40-figure deck costs more passes, never a bigger pass: a pass's cost grows
 * with the square of its turns, which is why one pass over everything would
 * run out (2026-11-24, verification-submit.ts VERIFICATION_OP_BUDGET).
 *
 * The passes' verdicts come back one by one (figureBatchEnded, from
 * session-bridge-verification.ts); when the last one ends, the run's outcome
 * goes to the note and, on mismatches, to one correction over every pass's
 * table. What each pass settled is kept per figure (figure-check-ledger.ts),
 * so "check the rest" knows what is left and the note can say how much was
 * covered ("Checked 16 of 40 figures").
 *
 * A file whose figures cannot be listed (a spreadsheet, a PDF) gets one pass
 * of the old shape: the verifier picks its own load-bearing values.
 */
import type { Op } from "../ops/types.js";
import type { FigureCheckScope, VerificationSubmitInput } from "./verification-spend.js";
import { figureLine, inventoryFigures, routineSampleSize, spreadPick, type Figure } from "./figure-inventory.js";
import { figureLedger, recordCheckedFigures } from "./figure-check-ledger.js";
import { expectFigureCheckRounds, figureCheckUpdate, type FigureCoverage } from "./figure-check-note.js";
import { isMismatchRow, verificationReport, type VerificationVerdict } from "./session-bridge-extractors.js";
import { submitVerificationOp } from "./verification-submit.js";

export const FIGURES_PER_PASS = 6;
export const PASSES_AT_ONCE = 3;

interface Listed { n: number; path: string; figure: Figure }
interface Batch { deliverables: string[]; listed: Listed[] }

export interface FigureCheckPlan {
  batches: Batch[];
  /** Figures listed across the files, null when one could not be listed. */
  total: number | null;
  paths: string[];
}

/** What a finished run comes to: what the note says and the correction gets. */
export interface FigureCheckOutcome {
  verdict: VerificationVerdict | null;
  /** The discrepant passes' final texts: the correction's table. */
  table: string;
  checked: number;
  mismatched: number;
  coverage?: FigureCoverage;
  /** A pass that found discrepancies: the correction is keyed on it. */
  discrepantOpId?: string;
  /** Files with a figure that did not match: what the correction may edit. */
  discrepantFiles: string[];
}

interface PassResult { opId: string; summary: string; verdict: VerificationVerdict | null; checked: number; mismatched: number; batch: Batch }

interface Run {
  sessionId: string;
  parentOp: Op;
  plan: FigureCheckPlan;
  queue: Batch[];
  live: Map<string, Batch>;
  ended: PassResult[];
}

const RUN_OF_OP = new Map<string, Run>();

/** List each file's figures and choose the ones this check covers. */
export async function planFigureCheck(deliverables: string[], scope: FigureCheckScope): Promise<FigureCheckPlan> {
  const listed: Listed[] = [];
  const unlisted: string[] = [];
  let total: number | null = 0;
  for (const path of deliverables) {
    const figures = await inventoryFigures(path);
    if (!figures || figures.length === 0) { unlisted.push(path); total = null; continue; }
    if (total !== null) total += figures.length;
    const ledger = scope === "all" ? new Map<string, boolean>() : figureLedger(path);
    const confirmed = figures.filter((f) => ledger.get(f.id) === true).length;
    // A figure that did not match last time comes first: that is how a correction is proved.
    const failed = figures.filter((f) => ledger.get(f.id) === false);
    const open = [...failed, ...figures.filter((f) => !ledger.has(f.id))];
    // Every figure that did not match is in, however much is confirmed: after a
    // correction the routine re-check is its proof.
    const want = scope === "routine" ? Math.max(failed.length, routineSampleSize(figures.length) - confirmed) : open.length;
    for (const figure of spreadPick(open, want)) listed.push({ n: listed.length + 1, path, figure });
  }
  const batches: Batch[] = [];
  for (let i = 0; i < listed.length; i += FIGURES_PER_PASS) {
    const part = listed.slice(i, i + FIGURES_PER_PASS);
    batches.push({ deliverables: [...new Set(part.map((l) => l.path))], listed: part });
  }
  if (unlisted.length) batches.push({ deliverables: unlisted, listed: [] });
  return { batches, total, paths: deliverables };
}

/** The files' coverage as the ledger has it now. */
function coverageOf(plan: FigureCheckPlan, unlistedChecked: number): FigureCoverage {
  let checked = unlistedChecked;
  for (const path of plan.paths) checked += figureLedger(path).size;
  return { checked, total: plan.total };
}

async function launch(run: Run): Promise<boolean> {
  const batch = run.queue.shift();
  if (!batch) return false;
  const input: VerificationSubmitInput = {
    parentOp: run.parentOp, sessionId: run.sessionId, deliverables: batch.deliverables,
    ...(batch.listed.length ? { figures: batch.listed.map((l) => figureLine(l.n, l.path, l.figure)) } : {}),
  };
  return submitVerificationOp(input, (opId) => { run.live.set(opId, batch); RUN_OF_OP.set(opId, run); });
}

/**
 * Plan and start a check: the default submitter behind verification-spend.ts.
 * True when at least one pass started, or when nothing was due because every
 * figure the check would cover is already confirmed (the note says so).
 */
export async function startFigureCheck(input: VerificationSubmitInput): Promise<boolean> {
  const plan = await planFigureCheck(input.deliverables, input.scope ?? "routine");
  if (plan.batches.length === 0) {
    figureCheckUpdate(input.sessionId, "confirmed", 0, coverageOf(plan, 0));
    return true;
  }
  const run: Run = { sessionId: input.sessionId, parentOp: input.parentOp, plan, queue: [...plan.batches], live: new Map(), ended: [] };
  expectFigureCheckRounds(input.sessionId, Math.ceil(plan.batches.length / PASSES_AT_ONCE));
  let started = false;
  for (let i = 0; i < PASSES_AT_ONCE && run.queue.length > 0; i++) started = (await launch(run)) || started;
  return started;
}

/** The figures a listed pass settled, by its table's # column: matched or not.
 *  A row marked unverified, or a figure with no row, settles nothing. */
export function settledFigures(summary: string, listed: Listed[]): Map<Listed, boolean> {
  const byN = new Map(listed.map((l) => [l.n, l]));
  const out = new Map<Listed, boolean>();
  for (const line of summary.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.replace(/[*_`]/g, "").trim()).filter(Boolean);
    const n = Number(cells[0]?.match(/^#?(\d+)$/)?.[1]);
    const l = byN.get(n);
    if (!l) continue;
    const verdict = (cells[cells.length - 1] ?? "").toLowerCase();
    if (isMismatchRow(line)) out.set(l, false);
    else if (/^(?:(?:yes|y|match|matches|true)\b|[✓✔✅])/u.test(verdict)) out.set(l, true);
  }
  return out;
}

function recordPass(batch: Batch, summary: string): { checked: number; mismatched: number } {
  const settled = settledFigures(summary, batch.listed);
  for (const path of batch.deliverables) {
    const results = new Map([...settled].filter(([l]) => l.path === path).map(([l, ok]) => [l.figure.id, ok]));
    recordCheckedFigures(path, results);
  }
  const values = [...settled.values()];
  return { checked: values.length, mismatched: values.filter((ok) => !ok).length };
}

/** What a pass over an unlisted file checked: its table's rows, but only when
 *  its verdict says it checked them. An UNVERIFIABLE pass still writes a table
 *  (each value "unverified"), and live 2026-11-25 a pass that could not open a
 *  corrupted deck was counted as 59 figures checked and reported "they match". */
function unlistedCounts(report: ReturnType<typeof verificationReport>): { checked: number; mismatched: number } {
  const checkedIt = report.verdict === "CONFIRMED" || report.verdict === "DISCREPANCIES";
  return checkedIt ? { checked: report.checked, mismatched: report.mismatched } : { checked: 0, mismatched: 0 };
}

function outcomeOf(run: Run): FigureCheckOutcome {
  const discrepant = run.ended.filter((r) => r.mismatched > 0 || r.verdict === "DISCREPANCIES");
  const checked = run.ended.reduce((n, r) => n + r.checked, 0);
  const mismatched = run.ended.reduce((n, r) => n + r.mismatched, 0);
  const unlistedChecked = run.ended.filter((r) => r.batch.listed.length === 0).reduce((n, r) => n + r.checked, 0);
  const verdict: VerificationVerdict | null = discrepant.length ? "DISCREPANCIES" : checked > 0 ? "CONFIRMED" : run.ended.some((r) => r.verdict === "UNVERIFIABLE") ? "UNVERIFIABLE" : null;
  return {
    verdict,
    table: discrepant.map((r) => r.summary).join("\n\n"),
    checked,
    mismatched,
    coverage: coverageOf(run.plan, unlistedChecked),
    ...(discrepant[0] ? { discrepantOpId: discrepant[0].opId } : {}),
    discrepantFiles: [...new Set(discrepant.flatMap((r) => r.batch.deliverables))],
  };
}

/**
 * One pass of a run ended. "not-a-run": the op is not part of one (its
 * caller handles it as a single pass); "pending": other passes are still
 * running or queued; otherwise the run's outcome.
 */
export async function figureBatchEnded(opId: string, summary: string): Promise<FigureCheckOutcome | "pending" | "not-a-run"> {
  const run = RUN_OF_OP.get(opId);
  if (!run) return "not-a-run";
  RUN_OF_OP.delete(opId);
  const batch = run.live.get(opId);
  run.live.delete(opId);
  if (batch) {
    const report = verificationReport(summary);
    const counts = batch.listed.length ? recordPass(batch, summary) : unlistedCounts(report);
    run.ended.push({ opId, summary, verdict: report.verdict, batch, ...counts });
  }
  while (run.live.size < PASSES_AT_ONCE && run.queue.length > 0) await launch(run);
  if (run.live.size > 0) return "pending";
  return outcomeOf(run);
}

/** Test-only: forget every run. */
export function _resetFigureCheckRunsForTests(): void {
  RUN_OF_OP.clear();
}

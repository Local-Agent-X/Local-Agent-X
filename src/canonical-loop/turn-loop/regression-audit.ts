// Regression-audit gate — the sixth completion gate.
//
// Complements spec-audit (did the diff satisfy the explicit REQUEST?) with a
// different question a completeness check structurally cannot ask: did the
// diff introduce a regression or risk nothing in the request would ever
// mention? Motivated by the 2026-09-09 CRM job-segments incident: the op's
// own build+tests were green and spec-audit had nothing to flag (the request
// WAS satisfied), yet the diff (a) silently broke an untouched page's query
// behavior, (b) leaked payment data to a less-privileged client payload
// behind client-side-only masking, (c) added a catch block that misattributed
// real failures, and (d) weakened two test assertions to make its own suite
// pass. A human only caught it by manually switching to a second model and
// asking it cold to audit the diff.
//
// Same fresh-context lever as spec-audit (conversation hidden, diff-only),
// PLUS one thing spec-audit deliberately doesn't need: a best-effort grep for
// OTHER files in the repo that reference an export/table the diff changed —
// evidence a single-op diff can never contain on its own, and exactly what
// would have surfaced the schedule-page breakage before the user found it.
//
// Audit model: by default the SAME active model with fresh eyes — spec-audit's
// proven lever ("the decorrelation lever is CONTEXT control, not a smarter
// model"). Opt-in: the regressionAuditProvider/regressionAuditModel settings
// route this ONE gate to a genuinely different, user-chosen provider instead
// (classifiers/regression-audit.ts's providerOverride). Never silent, never
// the default, and any failure to resolve it degrades to the same-model path
// — see resolve-regression-audit-provider.ts.
//
// NUDGE-ONLY, same contract as every gate in this chain: never a block, never
// a label demotion, at most one retry nudge per op, degrades to a no-op on
// any failure. Disable via LAX_REGRESSION_AUDIT=0. Per-op state cleared on op
// terminal via clearRegressionAuditStateForOp (state-machine.ts, alongside
// clearSpecAuditStateForOp).

import { dirname } from "node:path";
import { opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { auditRegressionRisk, AUDIT_EVIDENCE_LIMIT } from "../../classifiers/regression-audit.js";
import { resolveRegressionAuditProvider } from "../../providers/resolve-regression-audit-provider.js";
import { collectDiffEvidence } from "./diff-evidence.js";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";
import { createLogger } from "../../logger.js";
import type { Op } from "../../ops/types.js";

const logger = createLogger("canonical-loop.regression-audit");

// One audit per op, whatever the verdict — mirrors spec-audit's AUDITED set
// exactly, and deliberately a SEPARATE Set: the two gates are independent
// questions and a done-claim can legitimately re-arm one without the other.
const AUDITED = new Set<string>();

export function clearRegressionAuditStateForOp(opId: string): void {
  AUDITED.delete(opId);
}

/** Test-only — drop all per-op regression-audit state. */
export function _resetRegressionAuditState(): void {
  AUDITED.clear();
}

const GREP_TIMEOUT_MS = 15_000;
const MAX_IDENTIFIERS = 12;
const MAX_CONSUMER_FILES = 8;

// Best-effort: exported top-level bindings and Drizzle-style table
// declarations added or changed by the diff. Deliberately narrow (misses
// re-exports, default exports, non-JS/TS files) — a missed identifier just
// means the consumer section is shorter, never wrong, which matches the
// gate's bias-to-no-finding posture.
const IDENTIFIER_PATTERNS: RegExp[] = [
  /^\+\s*export\s+(?:async\s+)?function\s+(\w+)/,
  /^\+\s*export\s+(?:const|class|interface|type)\s+(\w+)/,
  /^\+.*\bpgTable\(\s*["'`](\w+)["'`]/,
];

export function extractChangedIdentifiers(diffText: string): string[] {
  const found = new Set<string>();
  for (const line of diffText.split("\n")) {
    for (const re of IDENTIFIER_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1]) found.add(m[1]);
    }
    if (found.size >= MAX_IDENTIFIERS) break;
  }
  return [...found].slice(0, MAX_IDENTIFIERS);
}

/**
 * Best-effort blast-radius evidence: other tracked files that reference a
 * symbol/table the diff added or changed, but were not themselves part of
 * this op's edits. NOT proof of breakage on its own — the audit prompt is
 * explicit that this list only says where to look. Empty string on any
 * failure (not a git repo, grep errors, no identifiers) — never blocks the
 * evidence collection this rides alongside.
 */
export async function defaultFindConsumers(
  identifiers: string[],
  editedAbsPaths: string[],
  signal?: AbortSignal,
): Promise<string> {
  if (identifiers.length === 0 || editedAbsPaths.length === 0) return "";
  const pattern = identifiers.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  try {
    const r = await bashTool.execute({
      command: `git grep -l -E "${pattern}" -- "*.ts" "*.tsx"`,
      _cwd: dirname(editedAbsPaths[0]),
      _signal: signal,
      timeout: GREP_TIMEOUT_MS,
    });
    if (statusOf(r) !== "ok") return "";
    const editedNormalized = editedAbsPaths.map((p) => p.replace(/\\/g, "/"));
    const files = (r.content ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => !editedNormalized.some((edited) => edited.endsWith(f)))
      .slice(0, MAX_CONSUMER_FILES);
    if (files.length === 0) return "";
    return (
      `OTHER FILES REFERENCING CHANGED EXPORTS/TABLES (not part of this diff — ` +
      `NOT proof of breakage on their own, only where to look):\n` +
      files.map((f) => `- ${f}`).join("\n")
    );
  } catch {
    return "";
  }
}

async function defaultCollectEvidence(absPaths: string[], signal?: AbortSignal): Promise<string> {
  const diff = await collectDiffEvidence(absPaths, AUDIT_EVIDENCE_LIMIT, signal);
  if (diff.length === 0) return "";
  const identifiers = extractChangedIdentifiers(diff);
  const consumers = await defaultFindConsumers(identifiers, absPaths, signal);
  return consumers ? `${diff}\n\n${consumers}` : diff;
}

function formatFindingsForAgent(findings: string[]): string {
  const rows = findings.map((f, i) => `  ${i + 1}. ${f}`).join("\n");
  return (
    `STOP — before accepting "done", a second fresh-eyes pass reviewed your ACTUAL DIFF ` +
    `(no conversation, no rationale) for regressions the request never mentioned and your own ` +
    `tests may not cover. It found:\n\n${rows}\n\n` +
    `For each item: if it is a false alarm, say why with a concrete pointer; otherwise fix it now. ` +
    `Do not claim completion while a real regression is unaddressed.`
  );
}

export interface RegressionAuditGateResult {
  /** Formatted findings block for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done" for one retry. */
  shouldRetry: boolean;
}

export interface RegressionAuditOptions {
  editedPaths?: string[];
  audit?: typeof auditRegressionRisk;
  collectEvidence?: (absPaths: string[], signal?: AbortSignal) => Promise<string>;
  resolveProviderOverride?: typeof resolveRegressionAuditProvider;
  signal?: AbortSignal;
}

const NO_RETRY: RegressionAuditGateResult = { nudge: "", shouldRetry: false };

/**
 * Decide whether to suppress this turn's terminal "done" by auditing the op's
 * diff for regression risk in a fresh context.
 *
 * Contract (the caller enforces the entry gate):
 *   - Call only when terminalReason === "done" and the op edited source.
 *   - Audits ONCE per op; a null verdict (classifier down, unparseable) or an
 *     empty-findings verdict degrades to today's behavior — NEVER a false nudge.
 *   - Records nothing into the outcome ledger — a fallible auditor must never
 *     demote the label. Its only power is one retry nudge naming the findings.
 */
export async function runRegressionAuditGate(op: Op, opts: RegressionAuditOptions = {}): Promise<RegressionAuditGateResult> {
  if (AUDITED.has(op.id)) return NO_RETRY;

  const raw = opts.editedPaths ?? opEditedSourcePaths(op.id);
  if (raw.length === 0) return NO_RETRY;

  const sessionId = getSessionForOp(op.id);
  const abs = raw.map((p) => resolveAgentPath(p, sessionId));

  const collect = opts.collectEvidence ?? defaultCollectEvidence;
  let evidence = "";
  try {
    evidence = (await collect(abs, opts.signal)).trim();
  } catch (e) {
    logger.debug(`op=${op.id} evidence collection failed (${(e as Error).message}) — gate is a no-op`);
    return NO_RETRY;
  }
  if (evidence.length === 0) {
    logger.debug(`op=${op.id} no diff and no readable edited file — gate is a no-op`);
    return NO_RETRY;
  }

  AUDITED.add(op.id);

  const resolveOverride = opts.resolveProviderOverride ?? resolveRegressionAuditProvider;
  let providerOverride: Awaited<ReturnType<typeof resolveRegressionAuditProvider>>;
  try {
    providerOverride = await resolveOverride();
  } catch (e) {
    logger.debug(`op=${op.id} audit-provider override resolution failed (${(e as Error).message}) — same-model audit`);
    providerOverride = null;
  }

  const audit = opts.audit ?? auditRegressionRisk;
  const findings = await audit({ evidence, signal: opts.signal, providerOverride: providerOverride ?? undefined });
  if (findings === null) {
    logger.info(`op=${op.id} regression audit returned no verdict (classifier unavailable or unparseable) — gate is a no-op for this op`);
    return NO_RETRY;
  }
  logger.info(`op=${op.id} fresh-context regression audit (provider=${providerOverride?.provider ?? "same-model"}) → ${findings.length === 0 ? "clean" : `${findings.length} finding(s)`}`);
  if (findings.length === 0) return NO_RETRY;

  return { nudge: formatFindingsForAgent(findings), shouldRetry: true };
}

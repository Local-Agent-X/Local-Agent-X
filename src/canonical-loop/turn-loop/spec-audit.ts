// Spec-audit gate (grok-lift pick #4 — the completeness gate).
//
// The documented residual failure the executable gates can't reach:
// build-green ≠ complete. A cleanup that leaves a live user-facing string the
// request said to remove, a request that named three changes and got two —
// every compiler/test/probe gate passes, because none of them re-reads the
// REQUEST. This gate does: at a done-claim, ONE fresh-context call (see
// classifiers/done-claim-audit.ts) where the SAME active model re-reads the
// original request against the op's actual changes — a git diff when
// available, final file contents otherwise — with the conversation hidden, so
// it cannot inherit the worker's own rationalizations about why the work is
// done.
//
// Called from decide-outcome when terminalReason === "done" AND the op edited
// source, AFTER the executable gates (render/build/spec-probe) so the audit
// never duplicates what ground truth already caught. NUDGE-ONLY, never a block
// and never a label demotion: the auditor is fallible model opinion, so its
// only power is ONE capped retry nudge naming the unmet items. Fires at most
// once per op — whatever the model does with the nudge stands. Everything
// degrades to a no-op (today's behavior) on any failure; disable via
// LAX_SPEC_AUDIT=0. Per-op state cleared on op terminal via
// clearSpecAuditStateForOp (state-machine.ts).

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { firstUserMessageText, appliedRedirectTexts } from "../store.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { auditDoneClaim, AUDIT_EVIDENCE_LIMIT } from "../../classifiers/done-claim-audit.js";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";
import { createLogger } from "../../logger.js";
import type { Op } from "../../ops/types.js";

const logger = createLogger("canonical-loop.spec-audit");

const DIFF_TIMEOUT_MS = 20_000;
/** Paths handed to `git diff` / the contents fallback — beyond this a sweep is
 *  too wide for one audit context anyway; head of the list wins. */
const MAX_EVIDENCE_PATHS = 25;
const MAX_CONTENT_FILES = 3;
const MIN_REQUEST_CHARS = 12;

// One audit per op, whatever the verdict — a fresh done-claim after the nudge
// is NOT re-audited (the model already answered the findings; re-auditing
// would loop opinion against opinion). Marked BEFORE the LLM call so a
// provider failure also short-circuits future done-claims, mirroring
// spec-probes' null-cache.
const AUDITED = new Set<string>();

export function clearSpecAuditStateForOp(opId: string): void {
  AUDITED.delete(opId);
}

/** Test-only — drop all per-op spec-audit state. */
export function _resetSpecAuditState(): void {
  AUDITED.clear();
}

function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.slice(limit).split("\n").length;
  return `${text.slice(0, limit)}\n… (truncated — ${dropped} more lines)`;
}

/**
 * The op's changes, as the auditor will see them. Prefer `git diff HEAD`
 * restricted to the edited paths (shows removals as well as additions); when
 * the project isn't a git repo, the diff errors, or the work was already
 * committed (empty diff), fall back to the final contents of the first few
 * edited files — completeness findings ("a live X remains") only need final
 * state. Empty string → the gate stands down.
 */
async function defaultCollectEvidence(absPaths: string[], signal?: AbortSignal): Promise<string> {
  const paths = absPaths.slice(0, MAX_EVIDENCE_PATHS);
  if (paths.length === 0) return "";
  try {
    const quoted = paths.map((p) => `"${p}"`).join(" ");
    const r = await bashTool.execute({
      command: `git diff HEAD -- ${quoted}`,
      _cwd: dirname(paths[0]),
      _signal: signal,
      timeout: DIFF_TIMEOUT_MS,
    });
    const diff = (r.content ?? "").trim();
    if (statusOf(r) === "ok" && diff.length > 0) {
      return truncateHead(diff, AUDIT_EVIDENCE_LIMIT);
    }
  } catch {
    // fall through to contents
  }
  const perFile = Math.floor(AUDIT_EVIDENCE_LIMIT / MAX_CONTENT_FILES);
  const parts: string[] = [];
  for (const p of paths.slice(0, MAX_CONTENT_FILES)) {
    try {
      const text = readFileSync(p, "utf-8");
      parts.push(`===== FINAL CONTENT: ${basename(p)} =====\n${truncateHead(text, perFile)}`);
    } catch {
      continue; // deleted/unreadable — nothing to show for it
    }
  }
  return parts.join("\n\n");
}

function formatUnmetForAgent(unmet: string[]): string {
  const rows = unmet.map((u, i) => `  ${i + 1}. ${u}`).join("\n");
  return (
    `STOP — before accepting "done", the harness re-read your ORIGINAL request with fresh eyes ` +
    `against your actual changes (request + diff only, no conversation). These explicitly ` +
    `requested items appear UNMET:\n\n${rows}\n\n` +
    `For each item: if it is genuinely done, state exactly where; otherwise do it now. ` +
    `Do not claim completion while an explicitly requested item is missing.`
  );
}

export interface SpecAuditGateResult {
  /** Formatted unmet-items block for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done" for one retry. */
  shouldRetry: boolean;
}

export interface SpecAuditOptions {
  editedPaths?: string[];
  audit?: typeof auditDoneClaim;
  collectEvidence?: (absPaths: string[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

const NO_RETRY: SpecAuditGateResult = { nudge: "", shouldRetry: false };

/**
 * Decide whether to suppress this turn's terminal "done" by auditing the op's
 * changes against the user's original request in a fresh context.
 *
 * Contract (the caller enforces the entry gate):
 *   - Call only when terminalReason === "done" and the op edited source.
 *   - Audits ONCE per op; a null verdict (classifier down, unparseable) or an
 *     all-met verdict degrades to today's behavior — NEVER a false nudge.
 *   - Records nothing into the outcome ledger — a fallible auditor must never
 *     demote the label. Its only power is one retry nudge naming unmet items.
 */
export async function runSpecAuditGate(op: Op, opts: SpecAuditOptions = {}): Promise<SpecAuditGateResult> {
  if (AUDITED.has(op.id)) return NO_RETRY;

  const raw = opts.editedPaths ?? opEditedSourcePaths(op.id);
  if (raw.length === 0) return NO_RETRY;
  let request = firstUserMessageText(op.id).trim();
  if (request.length < MIN_REQUEST_CHARS) return NO_RETRY;
  // The request the audit re-reads is the WHOLE ask: mid-op redirect
  // instructions are amendments to it, and they used to vanish from every
  // gate once consumed (one-slot column cleared on apply, prompt row
  // transport-only). A worker that narrates compliance with a redirect but
  // never edits the code sailed through here because the audited request
  // never mentioned the amendment — 2026-07-13, "make sure its not dark
  // theme" → four theme:'dark' defaults untouched → MET.
  const amendments = appliedRedirectTexts(op.id);
  if (amendments.length > 0) {
    request += `\n\nMid-build user amendments (each must be satisfied like the request above):\n` +
      amendments.map((t, i) => `${i + 1}. ${t}`).join("\n");
  }

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
  const audit = opts.audit ?? auditDoneClaim;
  const unmet = await audit({ userRequest: request, evidence, signal: opts.signal });
  if (unmet === null) {
    // Name the no-op: a silent null made a benchmark arm undiagnosable once
    // before (spec-probes, opus 2026-07-02).
    logger.info(`op=${op.id} audit returned no verdict (classifier unavailable or unparseable) — gate is a no-op for this op`);
    return NO_RETRY;
  }
  logger.info(`op=${op.id} fresh-context request audit → ${unmet.length === 0 ? "MET" : `${unmet.length} unmet item(s)`}`);
  if (unmet.length === 0) return NO_RETRY;

  return { nudge: formatUnmetForAgent(unmet), shouldRetry: true };
}

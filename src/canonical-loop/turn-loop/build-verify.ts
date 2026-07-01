// Build-verification gate. The orchestrator's answer to "the model edited
// source, said done, and never verified" — instead of only NUDGING the model
// to run the build (which a weak model dodges: runs a stale check, claims
// clean), the orchestrator runs the project's OWN build/type-check itself,
// between turns, and injects the REAL errors as the next turn's user message.
// The environment becomes the critic — same shape as render-verify (Tier 1.A),
// but for the project compiler instead of the preview iframe.
//
// Called from decide-outcome only when terminalReason === "done" AND the op
// edited source without a clean self-verify (opEditedSourceUnverified). The
// result is fed back into the verify-gate ledger so the outcome label is honest
// either way: a clean orchestrator build records clean, a red one stays partial.
//
// Per-op retry counter caps the fix loop so an unfixable build can't spin; it
// clears on op terminal via clearBuildVerifyStateForOp (state-machine.ts).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { detectBuildCommand, type FsProbe } from "../../agent-guards/index.js";
import { opEditedSourcePaths, recordOrchestratorVerify } from "../middlewares/verify-gate.js";
import { projectRoot } from "../../workspace/paths.js";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";
import { createLogger } from "../../logger.js";
import type { Op } from "../../ops/types.js";

const logger = createLogger("canonical-loop.build-verify");

const RETRIES = new Map<string, number>();

const MAX_RETRIES = 2;
const BUILD_TIMEOUT_MS = 180_000;
const NUDGE_BODY_LIMIT = 4000;

export function getBuildVerifyRetries(opId: string): number {
  return RETRIES.get(opId) ?? 0;
}

function bumpBuildVerifyRetries(opId: string): number {
  const next = (RETRIES.get(opId) ?? 0) + 1;
  RETRIES.set(opId, next);
  return next;
}

export function clearBuildVerifyStateForOp(opId: string): void {
  RETRIES.delete(opId);
}

/** Test-only — drop all per-op build-verify state. */
export function _resetBuildVerifyState(): void {
  RETRIES.clear();
}

const realProbe: FsProbe = {
  exists: (p) => existsSync(p),
  readJson: (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  },
};

/** Run the detected command and reduce it to a pass/output verdict. Anything
 *  short of a clean exit (error, timeout, blocked) counts as "not verified" —
 *  we never round a non-zero or aborted build up to green. */
async function defaultExec(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  const r = await bashTool.execute({ command, _cwd: cwd, timeout: BUILD_TIMEOUT_MS });
  return { ok: statusOf(r) === "ok", output: r.content };
}

/** Head-truncate compiler output: the first errors are the root causes (a
 *  renamed export, a deleted symbol); later ones cascade from them. */
function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const droppedLines = text.slice(limit).split("\n").length;
  return `${head}\n… (truncated — ${droppedLines} more lines)`;
}

function formatBuildErrorsForAgent(command: string, cwd: string, output: string, kind: string): string {
  return (
    `STOP — your edits left the project's ${kind} FAILING.\n\n` +
    `You wrapped up without verifying, so the harness ran \`${command}\` in ${cwd} on your ` +
    `behalf. It exited with errors:\n\n` +
    "```\n" + truncateHead(output.trim(), NUDGE_BODY_LIMIT) + "\n```\n\n" +
    `Do NOT report this done, complete, or working while it is red. Read every error above, ` +
    `fix them all, and the work is finished. An error in a file you did NOT edit means you ` +
    `changed something it depends on — a renamed or removed export, a changed signature, a ` +
    `deleted symbol. Fix the root cause, not just the file you were looking at.`
  );
}

/** Green-path counterpart to formatBuildErrorsForAgent: the model edited source
 *  but couldn't self-verify (blocked from running the build on source paths), so
 *  it may have wrapped up sounding unsure. The harness ran the build and it
 *  PASSED — say so, so the committed record matches the verdict the label
 *  already reflects instead of leaving a false "unverified" as the last word. */
function formatVerifiedForAgent(command: string, cwd: string, kind: string): string {
  return (
    `✓ Verified: the harness ran \`${command}\` in ${cwd} and the project's ${kind} passed ` +
    `with no errors — the change is complete and verified.`
  );
}

export interface BuildVerifyGateResult {
  /** Formatted error block for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done". */
  shouldRetry: boolean;
  /** Retry cap reached — build still red, but stop looping; label stays partial. */
  capReached: boolean;
  /** The orchestrator actually RAN the build and it passed (not merely "no
   *  buildable project found"). Distinguishes a real green from a no-op. */
  verifiedClean: boolean;
  /** Green-path confirmation for the committed record (empty unless verifiedClean). */
  confirmation: string;
}

export interface BuildVerifyOptions {
  /** Override the edited-path source (default: the verify-gate ledger). */
  editedPaths?: string[];
  /** Override the filesystem probe (default: node:fs). */
  probe?: FsProbe;
  /** Override the command runner (default: bashTool in the sandbox cage). */
  exec?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
}

const NO_RETRY: BuildVerifyGateResult = { nudge: "", shouldRetry: false, capReached: false, verifiedClean: false, confirmation: "" };

/**
 * Decide whether to suppress this turn's terminal "done" by running the
 * project's build/type-check ourselves.
 *
 * Contract (the caller enforces the entry gate):
 *   - Call only when terminalReason === "done" and opEditedSourceUnverified.
 *   - Detects the command from the op's edited paths; if no buildable project
 *     is found, returns shouldRetry=false WITHOUT fabricating a verdict (the
 *     existing partial label already covers "edited but couldn't verify").
 *   - Records the build verdict into the verify-gate ledger so the outcome
 *     label is honest, then either loops (red, under cap) or lets "done" stand.
 */
export async function runBuildVerifyGate(op: Op, opts: BuildVerifyOptions = {}): Promise<BuildVerifyGateResult> {
  const raw = opts.editedPaths ?? opEditedSourcePaths(op.id);
  const editedPaths = raw.map((p) => (isAbsolute(p) ? p : resolve(projectRoot(), p)));
  if (editedPaths.length === 0) return NO_RETRY;

  const probe = opts.probe ?? realProbe;
  const detected = detectBuildCommand(editedPaths, probe);
  if (!detected) {
    logger.debug(`op=${op.id} edited source but no buildable project found in ${editedPaths.length} path(s) — can't self-verify`);
    return NO_RETRY;
  }

  const exec = opts.exec ?? defaultExec;
  const res = await exec(detected.command, detected.cwd);
  logger.info(`op=${op.id} ran \`${detected.command}\` in ${detected.cwd} → ${res.ok ? "PASSED" : "FAILED"} (retry ${getBuildVerifyRetries(op.id)})`);

  // Authoritative verdict into the edit/verify ledger: clean → outcome clean,
  // red → outcome partial. Done before the retry branches so the label is
  // correct whether or not we loop.
  recordOrchestratorVerify(op.id, res.ok);

  if (res.ok) {
    return {
      nudge: "",
      shouldRetry: false,
      capReached: false,
      verifiedClean: true,
      confirmation: formatVerifiedForAgent(detected.command, detected.cwd, detected.kind),
    };
  }

  const nudge = formatBuildErrorsForAgent(detected.command, detected.cwd, res.output, detected.kind);
  if (getBuildVerifyRetries(op.id) >= MAX_RETRIES) {
    return { nudge, shouldRetry: false, capReached: true, verifiedClean: false, confirmation: "" };
  }
  bumpBuildVerifyRetries(op.id);
  return { nudge, shouldRetry: true, capReached: false, verifiedClean: false, confirmation: "" };
}

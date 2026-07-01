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
import { detectBuildCommand, detectTestCommand, type FsProbe } from "../../agent-guards/index.js";
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

/** Test-failure counterpart: the edit type-checks, but a test the op TOUCHED is
 *  red. A type-clean change whose own test fails is not done — and the model
 *  couldn't run the test itself (blocked on source paths), so surface it. */
function formatTestFailuresForAgent(command: string, cwd: string, output: string): string {
  return (
    `STOP — your edits type-check, but a test you touched is FAILING.\n\n` +
    `You edited a test file and wrapped up without running it, so the harness ran \`${command}\` ` +
    `in ${cwd} on your behalf. It failed:\n\n` +
    "```\n" + truncateHead(output.trim(), NUDGE_BODY_LIMIT) + "\n```\n\n" +
    `Do NOT report this done while a test is red. Either the code is wrong or the test's ` +
    `expectation is wrong — read the assertion, decide which, and make them agree. Don't just ` +
    `delete the assertion to go green; fix the real mismatch.`
  );
}

interface EditedFileSize {
  /** Path as the model would refer to it (relative to the build cwd when possible). */
  display: string;
  /** Line count the way `wc -l` reports it (newline count). */
  lines: number;
}

/** Cap on files enumerated in the confirmation so a wide sweep doesn't flood the
 *  transcript; the truncation is disclosed. */
const MAX_LISTED_FILES = 25;

/**
 * Measure the on-disk line count of each edited file, `wc -l` semantics (newline
 * count) — the exact number the model or the user would get running `wc -l`, so
 * a fabricated size ("this file is 294 lines" when it's 588) is contradicted by
 * the same measure. Deleted / unreadable paths are skipped (a split that removed
 * a file has no size to report).
 */
function measureEditedFiles(editedPaths: readonly string[], cwd: string): EditedFileSize[] {
  const out: EditedFileSize[] = [];
  for (const p of editedPaths) {
    let text: string;
    try {
      text = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const lines = text.match(/\n/g)?.length ?? 0;
    const display = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/, "") : p;
    out.push({ display, lines });
  }
  return out;
}

/** A line-count claim in prose: "294 lines", "530 LOC", "under 400 lines". Cheap
 *  structural trigger — a false positive only adds a (correct) sizes note; a miss
 *  degrades to today's silence. */
const SIZE_CLAIM_RE = /\b\d{2,}\s*(?:lines?|loc)\b/i;

/**
 * Ground-truth file sizes as an authoritative op-end note — the counterpart to
 * the claim-verify guards, which catch a lie about what a TOOL did but not a lie
 * about what a FILE is (its size). When the model's own summary quotes a line
 * count ("AgentController.ts is 294 lines" when it's 588), the harness measures
 * the edited files itself (`wc -l` semantics) and states the real numbers, so a
 * fabricated count can't be the last word. Fires WHETHER OR NOT the model
 * self-verified (unlike the build gate) — it keys on the reply making a size
 * claim, not on the build path. Silent (null) when the reply quoted no size or no
 * edited file is readable, so it adds zero noise to the ~all edits where size was
 * never discussed.
 */
export function groundTruthSizesNote(opId: string, assistantText: string): string | null {
  if (!SIZE_CLAIM_RE.test(assistantText)) return null;
  const paths = opEditedSourcePaths(opId).map((p) => (isAbsolute(p) ? p : resolve(projectRoot(), p)));
  if (paths.length === 0) return null;
  const sizes = measureEditedFiles(paths, projectRoot());
  if (sizes.length === 0) return null;
  const listed = sizes.slice(0, MAX_LISTED_FILES);
  const more = sizes.length - listed.length;
  const rows = listed.map((s) => `  - ${s.display} — ${s.lines} lines`).join("\n");
  return (
    `Ground-truth size of the files edited this task, measured on disk now ` +
    `(matches \`wc -l\`) — trust these over any remembered or estimated line counts:\n` +
    rows +
    (more > 0 ? `\n  - … and ${more} more` : "")
  );
}

/** Green-path counterpart to formatBuildErrorsForAgent: the model edited source
 *  but couldn't self-verify (blocked from running the build on source paths), so
 *  it may have wrapped up sounding unsure. The harness ran the checks and they
 *  PASSED — say so, so the committed record matches the verdict the label
 *  already reflects instead of leaving a false "unverified" as the last word. */
function formatVerifiedForAgent(checks: readonly { command: string; cwd: string }[]): string {
  const ran = checks.map((c) => `\`${c.command}\``).join(" and ");
  return (
    `✓ Verified: the harness ran ${ran} in ${checks[0].cwd} and they passed ` +
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

  // Red-path result: record the partial verdict, then loop (under cap) or stop
  // looping. Shared by the type-check and the edited-test failure branches so a
  // single retry counter governs both.
  const redResult = (nudge: string): BuildVerifyGateResult => {
    recordOrchestratorVerify(op.id, false);
    if (getBuildVerifyRetries(op.id) >= MAX_RETRIES) {
      return { nudge, shouldRetry: false, capReached: true, verifiedClean: false, confirmation: "" };
    }
    bumpBuildVerifyRetries(op.id);
    return { nudge, shouldRetry: true, capReached: false, verifiedClean: false, confirmation: "" };
  };

  // 1. Type-check (fast, side-effect-free). The broken-reference class fails here.
  const build = await exec(detected.command, detected.cwd);
  logger.info(`op=${op.id} ran \`${detected.command}\` in ${detected.cwd} → ${build.ok ? "PASSED" : "FAILED"} (retry ${getBuildVerifyRetries(op.id)})`);
  if (!build.ok) return redResult(formatBuildErrorsForAgent(detected.command, detected.cwd, build.output, detected.kind));

  const checks: { command: string; cwd: string }[] = [{ command: detected.command, cwd: detected.cwd }];

  // 2. If the op edited a test file, run THOSE tests too. A type-clean change
  //    whose own test is red is not done — and the model couldn't run the test
  //    itself (blocked from shell on source paths), so it never saw the failure.
  const testCmd = detectTestCommand(editedPaths, probe);
  if (testCmd) {
    const test = await exec(testCmd.command, testCmd.cwd);
    logger.info(`op=${op.id} ran \`${testCmd.command}\` in ${testCmd.cwd} → ${test.ok ? "PASSED" : "FAILED"} (retry ${getBuildVerifyRetries(op.id)})`);
    if (!test.ok) return redResult(formatTestFailuresForAgent(testCmd.command, testCmd.cwd, test.output));
    checks.push({ command: testCmd.command, cwd: testCmd.cwd });
  }

  // 3. Every check green — record clean and hand back the confirmation.
  recordOrchestratorVerify(op.id, true);
  return {
    nudge: "",
    shouldRetry: false,
    capReached: false,
    verifiedClean: true,
    confirmation: formatVerifiedForAgent(checks),
  };
}

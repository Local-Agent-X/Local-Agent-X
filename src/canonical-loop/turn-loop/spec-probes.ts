// Spec-probe gate (grok-lift pick #1, the flagship — execution half).
//
// The documented residual failure: a coding model ships code that compiles but
// is behaviorally wrong, and its OWN self-tests share the same blind spot
// because it wrote them while looking at its implementation. The decorrelation
// lever is CONTEXT control, not a smarter model: the SAME active model (Grok
// checks Grok, Gemini checks Gemini — routed through the active provider by
// oracle-probe-gen) authors an acceptance check while it sees ONLY the task
// spec + the file NAMES, never the code. This gate then EXECUTES that probe so a
// failure is ground truth (a real traceback), not more fallible model opinion.
//
// Called from decide-outcome when terminalReason === "done" AND the op edited
// source — regardless of whether the model self-verified, because a passing
// self-test is exactly the blind spot we're decorrelating from. Same shape as
// build-verify (orchestrator runs a check between turns, injects the result as
// the next turn's user message) but the check is a spec-derived behavioral
// probe, not the project compiler.
//
// NUDGE-ONLY, never a block and never a label demotion: the probe's authorship
// is fallible (it guessed the API from a file name), so a probe that can't
// validly exercise the code — import error, wrong-symbol guess, unrunnable
// interpreter — is discarded as INVALID and NEVER counted red. Only a probe that
// RAN and tripped a spec assertion nudges. Everything degrades to null (today's
// behavior) on any failure. Per-op retry counter caps the loop; cleared on op
// terminal via clearSpecProbeStateForOp (state-machine.ts).

import { writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { readOpMessages } from "../store.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { generateOracleProbe, type OracleProbe, type ProbeLanguage } from "../../classifiers/oracle-probe-gen.js";
import { bashTool } from "../../tools/shell-tool.js";
import { statusOf } from "../../tools/result-helpers.js";
import { createLogger } from "../../logger.js";
import type { Op } from "../../ops/types.js";

const logger = createLogger("canonical-loop.spec-probes");

const MAX_RETRIES = 2;
const PROBE_TIMEOUT_MS = 30_000;
const NUDGE_BODY_LIMIT = 3000;

const RETRIES = new Map<string, number>();
// Per-op cache of the generated probe so a retry loop doesn't re-pay the LLM call
// each done-claim. A cached `null` means "no usable probe" (the author abstained,
// the classifier was unavailable, or a run proved the probe INVALID) — future
// gate calls short-circuit instead of regenerating or re-running a dud.
const PROBE_CACHE = new Map<string, OracleProbe | null>();

export function getSpecProbeRetries(opId: string): number {
  return RETRIES.get(opId) ?? 0;
}

function bumpSpecProbeRetries(opId: string): void {
  RETRIES.set(opId, (RETRIES.get(opId) ?? 0) + 1);
}

export function clearSpecProbeStateForOp(opId: string): void {
  RETRIES.delete(opId);
  PROBE_CACHE.delete(opId);
}

/** Test-only — drop all per-op spec-probe state. */
export function _resetSpecProbeState(): void {
  RETRIES.clear();
  PROBE_CACHE.clear();
}

// The probe's authorship was IMPLEMENTATION-BLIND, so a non-zero exit has two
// very different causes and only ONE is a real finding:
//   • the probe RAN and a spec assertion FAILED        → red (nudge)
//   • the probe couldn't validly exercise the code      → INVALID (discard)
// INVALID covers every way the author's guess-from-a-filename can miss: the
// module name is wrong (import error), the function/attribute name is wrong
// (Attribute/Name/Reference error), the signature is wrong (TypeError), the
// solution doesn't parse (SyntaxError), the interpreter can't load the file
// (ERR_MODULE_NOT_FOUND / unknown extension), or the command isn't there. Biasing
// these to INVALID is deliberate: a mis-guessed probe must degrade to silence,
// never false-red-nag a correct implementation. AssertionError is intentionally
// absent — that is the one signal we DO treat as a genuine behavioral miss.
const PROBE_INVALID_RE =
  /\b(ModuleNotFoundError|ImportError|No module named|SyntaxError|IndentationError|TabError|NameError|AttributeError|TypeError|ReferenceError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_[A-Z_]+|Cannot find module|command not found|not found|No such file|ENOENT|Permission denied|Aborted)\b/i;

const EXT: Record<ProbeLanguage, string> = { python: "py", node: "mjs", shell: "sh" };
// `python3 -B`: never write .pyc. Co-locating the probe next to the solution
// otherwise leaves a __pycache__ in the user's tree AND, worse, can serve STALE
// bytecode — if the model edits the solution and re-claims done within the pyc's
// mtime+size invalidation window, the probe would re-run the OLD code and
// false-red-nag a solution that was just corrected. -B sidesteps both.
const RUNNER: Record<ProbeLanguage, string> = { python: "python3 -B", node: "node", shell: "sh" };

export type ProbeVerdict = "pass" | "red" | "invalid";

/**
 * Map a probe run to a verdict — the load-bearing anti-false-nag decision.
 *   - clean exit ("ok")                 → pass
 *   - non-error status (timeout/blocked/aborted) → invalid (environmental)
 *   - non-zero exit whose output looks like a probe-authoring miss → invalid
 *   - any other non-zero exit (a tripped spec assertion)           → red
 * Erring toward INVALID on ambiguity is intentional: a mis-guessed probe must
 * degrade to silence, never false-flag a correct implementation.
 */
export function classifyProbeRun(status: string, output: string): ProbeVerdict {
  if (status === "ok") return "pass";
  if (status !== "error") return "invalid";
  return PROBE_INVALID_RE.test(output) ? "invalid" : "red";
}

/**
 * Write the probe INTO the solution directory (a unique dotfile), run it there,
 * then delete it. Co-locating is what makes imports resolve for BOTH languages
 * without special flags: Python puts the script's own dir on sys.path[0] (so
 * `import wordy` finds wordy.py), and Node resolves an ESM relative `./x.js`
 * against the script file's dir — a probe written to /tmp could do neither. The
 * gate runs between turns and deletes the file immediately, so the model never
 * sees it (can't overfit to it) and nothing is left in the tree.
 */
async function defaultExec(probe: OracleProbe, solutionDir: string, signal?: AbortSignal): Promise<{ verdict: ProbeVerdict; output: string }> {
  const fileName = `.lax-probe-${randomUUID().slice(0, 8)}.${EXT[probe.language]}`;
  const probePath = join(solutionDir, fileName);
  try {
    writeFileSync(probePath, probe.script, "utf-8");
    const r = await bashTool.execute({
      command: `${RUNNER[probe.language]} ${fileName}`,
      _cwd: solutionDir,
      _signal: signal,
      timeout: PROBE_TIMEOUT_MS,
    });
    const output = r.content ?? "";
    return { verdict: classifyProbeRun(statusOf(r), output), output };
  } catch (e) {
    return { verdict: "invalid", output: (e as Error).message };
  } finally {
    try { unlinkSync(probePath); } catch { /* best-effort — a dotfile that outlives a crash is harmless */ }
  }
}

/** The op's first user message — the task spec the probe author anchors to.
 *  Mirrors situational-awareness.firstUserMessageText. */
function firstUserRequest(opId: string): string {
  const first = readOpMessages(opId).find((m) => m.role === "user");
  if (!first) return "";
  const c = first.content;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
    return (c as { text: string }).text;
  }
  return "";
}

/** Pick the directory to run the probe in: the one holding the most edited source
 *  files (ties → first edited). That's where the solution module lives, so a
 *  co-located probe can import it. */
function primaryEditDir(absPaths: string[]): string | null {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const p of absPaths) {
    const dir = dirname(p);
    if (!counts.has(dir)) order.push(dir);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (order.length === 0) return null;
  let best = order[0];
  for (const dir of order) if ((counts.get(dir) ?? 0) > (counts.get(best) ?? 0)) best = dir;
  return best;
}

function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const dropped = text.slice(limit).split("\n").length;
  return `${text.slice(0, limit)}\n… (truncated — ${dropped} more lines)`;
}

function formatProbeFailureForAgent(probe: OracleProbe, output: string): string {
  return (
    `STOP — an acceptance check derived from the task spec FAILED against your code.\n\n` +
    `Before accepting "done", the harness wrote a ${probe.language} check straight from the task ` +
    `description — WITHOUT seeing your implementation — and ran it. Your code executed but produced ` +
    `the wrong result on a case the spec requires:\n\n` +
    "```\n" + truncateHead(output.trim(), NUDGE_BODY_LIMIT) + "\n```\n\n" +
    `This is a behavioral bug, not a compile error — the code runs but does the wrong thing. Re-read ` +
    `the spec for the behavior this case exercises and fix the logic. The check ran outside your ` +
    `workspace and is already gone, so there is no test file to edit or delete — the only way past ` +
    `this is to make the code correct.`
  );
}

export interface SpecProbeGateResult {
  /** Formatted failure block for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done" for one retry. */
  shouldRetry: boolean;
}

export interface SpecProbeOptions {
  editedPaths?: string[];
  generate?: typeof generateOracleProbe;
  exec?: (probe: OracleProbe, solutionDir: string, signal?: AbortSignal) => Promise<{ verdict: ProbeVerdict; output: string }>;
  signal?: AbortSignal;
}

const NO_RETRY: SpecProbeGateResult = { nudge: "", shouldRetry: false };

/**
 * Decide whether to suppress this turn's terminal "done" by running a
 * spec-derived, implementation-blind acceptance probe against the op's edits.
 *
 * Contract (the caller enforces the entry gate):
 *   - Call only when terminalReason === "done" and the op edited source.
 *   - Generates the probe once per op (cached); a null probe or an INVALID run
 *     degrades to today's behavior (shouldRetry=false), NEVER a false nudge.
 *   - Records nothing into the outcome ledger — a fallible probe must never
 *     demote the label. Its only power is one capped retry nudge on a real miss.
 */
export async function runSpecProbeGate(op: Op, opts: SpecProbeOptions = {}): Promise<SpecProbeGateResult> {
  if (getSpecProbeRetries(op.id) >= MAX_RETRIES) return NO_RETRY;

  const raw = opts.editedPaths ?? opEditedSourcePaths(op.id);
  if (raw.length === 0) return NO_RETRY;
  const sessionId = getSessionForOp(op.id);
  const abs = raw.map((p) => resolveAgentPath(p, sessionId));
  const solutionDir = primaryEditDir(abs);
  if (!solutionDir) return NO_RETRY;

  let probe: OracleProbe | null;
  if (PROBE_CACHE.has(op.id)) {
    probe = PROBE_CACHE.get(op.id) ?? null;
  } else {
    const generate = opts.generate ?? generateOracleProbe;
    probe = await generate({
      userRequest: firstUserRequest(op.id),
      fileList: abs.map((p) => basename(p)),
      signal: opts.signal,
    });
    PROBE_CACHE.set(op.id, probe);
  }
  if (!probe) return NO_RETRY;

  const exec = opts.exec ?? defaultExec;
  const run = await exec(probe, solutionDir, opts.signal);
  logger.info(`op=${op.id} ran ${probe.language} spec-probe in ${solutionDir} → ${run.verdict} (retry ${getSpecProbeRetries(op.id)})`);

  if (run.verdict === "invalid") {
    // The probe couldn't validly exercise the code (mis-guessed API, wouldn't
    // load). Discard it so it never nudges — and forget it, so we don't re-run
    // the same dud on the next done-claim.
    PROBE_CACHE.set(op.id, null);
    return NO_RETRY;
  }
  if (run.verdict === "pass") return NO_RETRY;

  bumpSpecProbeRetries(op.id);
  return { nudge: formatProbeFailureForAgent(probe, run.output), shouldRetry: true };
}

/**
 * The chunk skeptic — the /greenfield skill's "prove it wrong" agent
 * (references/autonomous.md, section 6), run by the build engine on every
 * chunk before it counts as green.
 *
 * It runs on the canonical agent path as the `chunk-skeptic` role
 * (agents/chunk-runner.ts: read, search, shell and change-review tools, no
 * write or edit), in the tree the chunk was built in, after the builder has
 * returned. It gets the chunk's contract, the builder's report (the claim) and
 * the sha the chunk started from, and reads the diff itself.
 *
 * What it may hold the chunk to is the chunk's contract (skeptic-bar.ts): a
 * BROKEN verdict names its ground, and what the skeptic found beyond the
 * contract comes back as follow-ups, which are recorded and never hold the
 * chunk back. A finish fix is held to what it was given to fix
 * (FINISH_FIX_BAR_BLOCK); the next finish round attacks the whole app again.
 *
 * It ends its run by calling `skeptic_verdict` (agents/report-tools.ts), which
 * checks the verdict as it is given: a broken one must name its ground. No
 * text is parsed for it.
 *
 * A skeptic that gave no verdict (it crashed, timed out, was cancelled, or
 * ended its run without calling the tool) is not-run: nothing was shown either
 * way. It is asked once more; a second not-run is owed to the owner and the
 * build goes on, as for any check that could not run. Until 2026-11-26 an
 * answer with no VERDICT line read as BROKEN, and an empty one once cost a fix
 * round that changed nothing (label-check-sol, 2026-11-25).
 */

import type { ParsedChunk } from "../plan-parser.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runChunkAgent, SKEPTIC_PROBE_DIR } from "../agents/chunk-runner.js";
import type { SkepticVerdictCall } from "../agents/agent-report.js";
import { isFinishFixChunk } from "../finish-gates/fix-chunk.js";
import { FINISH_FIX_BAR_BLOCK } from "./skeptic-bar.js";

export type SkepticStatus = "broken" | "holds" | "not-run";

export interface SkepticVerdict {
  status: SkepticStatus;
  /** BROKEN: what breaks and how it was shown. HOLDS: what was tried.
   *  not-run: why the skeptic did not answer. */
  finding: string;
  /** What it found beyond the chunk's contract: for the ledger, never a
   *  reason to send the chunk back. Absent when it listed none. */
  followUps?: string[];
  /** BROKEN: the ground it named, as written. */
  ground?: string;
}

export interface SkepticInput {
  chunk: ParsedChunk;
  /** What the builder reported, in a few lines: the claim under attack. */
  claim: string;
  /** HEAD before the chunk was built: `git diff <preSha>` is the chunk. */
  preSha: string;
  /** The tree the chunk was built in (its worktree on the parallel path). */
  projectDir: string;
  /** How long the skeptic may go silent before it counts as hung (default 15 min). */
  silenceLimitMs?: number;
  signal?: AbortSignal;
  parentSessionId?: string;
  parentOpId?: string;
}

/** A skeptic gets a shorter leash than a builder: it reads and runs probes, it
 *  does not build, so 15 minutes with no output or tool call means it hung. */
const SKEPTIC_SILENCE_LIMIT_MS = 15 * 60_000;
const MAX_REPORT_CHARS = 4_000;

export function buildSkepticTask(input: Pick<SkepticInput, "chunk" | "claim" | "preSha">): string {
  const { chunk } = input;
  const report = input.claim.trim().slice(-MAX_REPORT_CHARS) || "(the builder made no report)";
  const finishFix = isFinishFixChunk(chunk);
  return (
    `Chunk ${chunk.number}: ${chunk.title} (${chunk.klass})\n\n` +
    `## What the chunk had to do\n\n` +
    `Slice: ${chunk.slice || "(none stated)"}\n\n` +
    `Done when:\n${chunk.doneWhen || "(none stated)"}\n\n` +
    `## The builder's claim (its final report)\n\n${report}\n\n` +
    (finishFix ? FINISH_FIX_BAR_BLOCK : "") +
    `## The change\n\n` +
    `The chunk started from commit \`${input.preSha}\`. Its work is everything since: ` +
    `\`git diff ${input.preSha}\` plus any new files \`git status\` lists as untracked.\n\n` +
    (finishFix
      ? `This change says it fixes what it was given. Prove it wrong by the finish-fix bar above: the ` +
        `finding that still reproduces, the test that passes without the fix, what the fix broke. ` +
        `Anything else you find is a follow-up, not a break. `
      : `This change says it is done and correct. Prove it wrong against the contract above and the ` +
        `project's \`spec/\`: the input it breaks on, the case it missed, the seam it forked, the test ` +
        `that cannot fail. What you find beyond the contract is a follow-up, not a break. `) +
    `End by calling skeptic_verdict.`
  );
}

/** The verdict the skeptic delivered, as the review reads it. A BROKEN finding
 *  leads with the ground it named, so the builder sees which line of its
 *  contract it broke. */
export function skepticVerdictOf(call: SkepticVerdictCall): SkepticVerdict {
  const broken = call.verdict === "broken";
  return {
    status: call.verdict,
    finding: broken ? `Breaks: ${call.ground}\n${call.finding}` : call.finding,
    ...(call.followUps.length ? { followUps: call.followUps.slice(0, MAX_FOLLOW_UPS) } : {}),
    ...(broken ? { ground: call.ground } : {}),
  };
}

const MAX_FOLLOW_UPS = 12;

/** Times the skeptic is asked when it does not answer. */
const SKEPTIC_ATTEMPTS = 2;

export async function runChunkSkeptic(input: SkepticInput): Promise<SkepticVerdict> {
  let verdict = await askSkeptic(input);
  for (let attempt = 1; attempt < SKEPTIC_ATTEMPTS && verdict.status === "not-run" && !input.signal?.aborted; attempt++) {
    verdict = await askSkeptic(input);
  }
  return verdict;
}

async function askSkeptic(input: SkepticInput): Promise<SkepticVerdict> {
  // The probe folder is the skeptic's own: gone when it finishes, so no probe
  // reaches the chunk's commit or the next reviewer. A folder of that name the
  // project already had is left alone.
  const probes = join(input.projectDir, SKEPTIC_PROBE_DIR);
  const ownFolder = !existsSync(probes);
  let result: Awaited<ReturnType<typeof runChunkAgent>>;
  try {
    result = await runChunkAgent({
      role: "chunk-skeptic",
      task: buildSkepticTask(input),
      title: `Skeptic: chunk ${input.chunk.number}, ${input.chunk.title}`,
      projectDir: input.projectDir,
      silenceLimitMs: input.silenceLimitMs ?? SKEPTIC_SILENCE_LIMIT_MS,
      signal: input.signal,
      parentSessionId: input.parentSessionId,
      parentOpId: input.parentOpId,
    });
  } finally {
    if (ownFolder) rmSync(probes, { recursive: true, force: true });
  }
  // A verdict it delivered stands however its run then ended.
  if (result.skepticVerdict) return skepticVerdictOf(result.skepticVerdict);
  if (result.exitCode !== 0) {
    return {
      status: "not-run",
      finding: `The skeptic did not finish (exit ${result.exitCode}${result.error ? `: ${result.error}` : ""}).`,
    };
  }
  return { status: "not-run", finding: "The skeptic ended its run without giving a verdict." };
}

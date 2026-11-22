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
 * Fail direction:
 *   - The skeptic answered with no parseable verdict → broken. The skill says
 *     "default to broken if unsure", and an agent that dodged the contract has
 *     not shown the change holds.
 *   - The skeptic never answered (crash, timeout, cancel) → not-run. Nothing
 *     was shown either way; the caller records the chunk as unverified and the
 *     build goes on, the same rule as every other gate's infra failure.
 */

import type { ParsedChunk } from "../plan-parser.js";
import { runChunkAgent } from "../agents/chunk-runner.js";

export type SkepticStatus = "broken" | "holds" | "not-run";

export interface SkepticVerdict {
  status: SkepticStatus;
  /** BROKEN: what breaks and how it was shown. HOLDS: what was tried.
   *  not-run: why the skeptic did not answer. */
  finding: string;
}

export interface SkepticInput {
  chunk: ParsedChunk;
  /** The builder's final report, verbatim: the claim under attack. */
  rawReport: string;
  /** HEAD before the chunk was built: `git diff <preSha>` is the chunk. */
  preSha: string;
  /** The tree the chunk was built in (its worktree on the parallel path). */
  projectDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  parentSessionId?: string;
  parentOpId?: string;
}

/** A skeptic gets a shorter leash than a builder: it reads and runs, it does
 *  not build. */
const SKEPTIC_TIMEOUT_MS = 15 * 60_000;
const MAX_REPORT_CHARS = 4_000;

export function buildSkepticTask(input: Pick<SkepticInput, "chunk" | "rawReport" | "preSha">): string {
  const { chunk } = input;
  const report = input.rawReport.trim().slice(-MAX_REPORT_CHARS) || "(the builder returned no report)";
  return (
    `Chunk ${chunk.number}: ${chunk.title} (${chunk.klass})\n\n` +
    `## What the chunk had to do\n\n` +
    `Slice: ${chunk.slice || "(none stated)"}\n\n` +
    `Done when:\n${chunk.doneWhen || "(none stated)"}\n\n` +
    `## The builder's claim (its final report)\n\n${report}\n\n` +
    `## The change\n\n` +
    `The chunk started from commit \`${input.preSha}\`. Its work is everything since: ` +
    `\`git diff ${input.preSha}\` plus any new files \`git status\` lists as untracked.\n\n` +
    `This change says it is done and correct. Prove it wrong: the input it breaks on, the case it ` +
    `missed, the seam it forked, the test that cannot fail. Default to broken if unsure. End with ` +
    `the VERDICT and FINDING lines.`
  );
}

/** Read the VERDICT / FINDING lines from the skeptic's last message. The last
 *  VERDICT line wins (a skeptic may quote the format before answering). No
 *  verdict line → broken: the skill's default when the skeptic is unsure. */
export function parseSkepticVerdict(raw: string): SkepticVerdict {
  const lines = raw.split(/\r?\n/);
  let verdictAt = -1;
  let verdict: "broken" | "holds" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\**VERDICT\**\s*:\s*\**\s*(BROKEN|HOLDS)\b/i);
    if (m) { verdictAt = i; verdict = m[1].toUpperCase() === "HOLDS" ? "holds" : "broken"; }
  }
  if (!verdict) {
    const said = raw.trim().slice(-600);
    return {
      status: "broken",
      finding: `The skeptic gave no VERDICT line, so the change is not shown to hold.${said ? ` Its last words: ${said}` : ""}`,
    };
  }
  const after = lines.slice(verdictAt + 1).join("\n");
  const finding = (after.match(/^\s*\**FINDING\**\s*:\s*([\s\S]*)$/im)?.[1] ?? after).trim();
  return { status: verdict, finding: finding || "(no finding given)" };
}

export async function runChunkSkeptic(input: SkepticInput): Promise<SkepticVerdict> {
  const result = await runChunkAgent({
    role: "chunk-skeptic",
    task: buildSkepticTask(input),
    title: `Skeptic: chunk ${input.chunk.number}, ${input.chunk.title}`,
    projectDir: input.projectDir,
    timeoutMs: input.timeoutMs ?? SKEPTIC_TIMEOUT_MS,
    signal: input.signal,
    parentSessionId: input.parentSessionId,
    parentOpId: input.parentOpId,
  });
  if (result.exitCode !== 0) {
    return {
      status: "not-run",
      finding: `The skeptic did not finish (exit ${result.exitCode}${result.error ? `: ${result.error}` : ""}).`,
    };
  }
  return parseSkepticVerdict(result.stdout);
}

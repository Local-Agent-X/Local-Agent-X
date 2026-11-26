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
 * Fail direction:
 *   - The skeptic answered with no parseable verdict → broken. An agent that
 *     dodged the verdict format has not shown the change holds. A BROKEN
 *     verdict that names no ground stays broken for the same reason.
 *   - The skeptic never answered (crash, timeout, cancel, or a turn that
 *     ended with nothing said, as when its model's stream died) → not-run.
 *     Nothing was shown either way, so it is asked once more; a second
 *     not-run is recorded as unverified and the build goes on, the same rule
 *     as every other gate's infra failure. An empty answer read as BROKEN
 *     once cost a fix round that changed nothing (label-check-sol, 2026-11-25).
 */

import type { ParsedChunk } from "../plan-parser.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runChunkAgent, SKEPTIC_PROBE_DIR } from "../agents/chunk-runner.js";
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
}

export interface SkepticInput {
  chunk: ParsedChunk;
  /** The builder's final report, verbatim: the claim under attack. */
  rawReport: string;
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

export function buildSkepticTask(input: Pick<SkepticInput, "chunk" | "rawReport" | "preSha">): string {
  const { chunk } = input;
  const report = input.rawReport.trim().slice(-MAX_REPORT_CHARS) || "(the builder returned no report)";
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
    `End with the VERDICT, GROUND, FINDING and FOLLOW_UPS lines.`
  );
}

/** A field's label at the start of a line, bold markers on either side of the colon allowed. */
const FIELD = (name: string): RegExp => new RegExp(`^\\s*\\**${name}\\**\\s*:\\s*\\**\\s*`, "i");
const FOLLOW_UPS = FIELD("FOLLOW[_ -]?UPS");
const MAX_FOLLOW_UPS = 12;

/** The lines under FOLLOW_UPS, one item each; "none" and blanks are nothing. */
function parseFollowUps(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line && !/^\(?none\)?\.?$/i.test(line))
    .slice(0, MAX_FOLLOW_UPS);
}

/** Read the verdict block from the skeptic's last message. The last VERDICT
 *  line wins (a skeptic may quote the format before answering). No verdict
 *  line → broken: it has not shown the change holds. A BROKEN finding leads
 *  with the ground the skeptic named, so the builder sees which line of its
 *  contract it broke. */
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
  const rest = lines.slice(verdictAt + 1);
  const followAt = rest.findIndex((line) => FOLLOW_UPS.test(line));
  const body = followAt < 0 ? rest : rest.slice(0, followAt);
  const followUps = followAt < 0 ? [] : parseFollowUps([rest[followAt].replace(FOLLOW_UPS, ""), ...rest.slice(followAt + 1)]);

  const groundAt = body.findIndex((line) => FIELD("GROUND").test(line));
  const ground = groundAt < 0 ? "" : body[groundAt].replace(FIELD("GROUND"), "").trim();
  const after = body.filter((_, i) => i !== groundAt).join("\n");
  const said = (after.match(/^\s*\**FINDING\**\s*:\s*([\s\S]*)$/im)?.[1] ?? after).trim() || "(no finding given)";
  const finding = verdict === "broken" && ground ? `Breaks: ${ground}\n${said}` : said;
  return { status: verdict, finding, ...(followUps.length ? { followUps } : {}) };
}

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
  if (result.exitCode !== 0) {
    return {
      status: "not-run",
      finding: `The skeptic did not finish (exit ${result.exitCode}${result.error ? `: ${result.error}` : ""}).`,
    };
  }
  if (!result.stdout.trim()) return { status: "not-run", finding: "The skeptic's turn ended without a word (its model returned nothing)." };
  return parseSkepticVerdict(result.stdout);
}

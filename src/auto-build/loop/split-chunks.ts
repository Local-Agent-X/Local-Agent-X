/**
 * A chunk the build lead split: it keeps part of its contract, and the rest
 * becomes new chunks of the plan, built in the same run after the plan's own.
 *
 * Narrowing alone made the rest a follow-up on the ledger, unbuilt. A chunk
 * that will not converge is often two pieces of work, one done and one not:
 * the lead splits it, the done piece lands, and the other is built as a chunk
 * of its own with a contract of its own.
 *
 * The new chunks are appended to the tree's spec/plan.md, under a heading of
 * their own, numbered from the chunk's (chunk 4's become 401, 402, ...) so two
 * chunks split in parallel worktrees never pick the same numbers. Chunks only
 * ever add to the plan this way, so a merge keeps both sides
 * (shared-file-merge.ts). They reach the base with the chunk that was split,
 * and a resume finds them in the plan like any other chunk. Each depends on
 * the chunk it came from; one whose origin did not land waits for a resume.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parsePlanFile, type ParsedChunk, type ParsedPlan } from "../plan-parser.js";
import type { LoopOptions, LoopResult } from "./types.js";

export interface SplitPart { title: string; doneWhen: string }

/** The plan in a tree the engine builds. */
const planIn = (tree: string): string => join(tree, "spec", "plan.md");

/** Append `parts` to the plan in `tree` as chunks split from `chunk`; their
 *  numbers, or null when the tree has no plan to grow. */
export function appendSplitChunks(tree: string, chunk: ParsedChunk, parts: SplitPart[]): number[] | null {
  const path = planIn(tree);
  if (!existsSync(path)) return null;
  const taken = new Set(parsePlanFile(path).chunks.map((c) => c.number));
  const numbers: number[] = [];
  for (let n = chunk.number * 100 + 1; numbers.length < parts.length; n++) if (!taken.has(n)) numbers.push(n);
  // Line breaks would end a plan bullet; every other space is the lead's own.
  const oneLine = (t: string) => t.replace(/\s*\n\s*/g, " ").trim();
  const sections = parts.map((p, i) => [
    `### Chunk ${numbers[i]} — ${oneLine(p.title)}`,
    `- **Class:** ${chunk.klass}`,
    `- **Slice:** ${oneLine(p.title)}. Split from chunk ${chunk.number} (${chunk.title}) by the build lead.`,
    `- **Depends on:** ${chunk.number}`,
    "- **Scenarios:** —",
    `- **Done when:** ${oneLine(p.doneWhen)}`,
  ].join("\n"));
  appendFileSync(path, `\n\n## Split from chunk ${chunk.number} — ${oneLine(chunk.title)}\n\n${sections.join("\n\n")}\n`);
  return numbers;
}

/** Chunks the base's plan gained this run whose origin landed. */
export function splitOffsToBuild(opts: LoopOptions, result: LoopResult): { plan: ParsedPlan; chunks: ParsedChunk[] } | null {
  if (!existsSync(opts.planPath)) return null;
  const known = new Set(opts.plan.chunks.map((c) => c.number));
  let grown: ParsedPlan;
  try {
    grown = parsePlanFile(opts.planPath);
  } catch {
    // A plan that no longer parses grew nothing this run can build; the run
    // ends on the plan it started with, and a resume reports the parse error.
    return null;
  }
  const added = grown.chunks.filter((c) => !known.has(c.number));
  if (added.length === 0) return null;
  const startIdx = opts.plan.chunks.findIndex((c) => c.number === opts.startingChunk);
  const landed = new Set([
    ...opts.plan.chunks.slice(0, Math.max(0, startIdx)).map((c) => c.number),
    ...(opts.landedChunks ?? []),
    ...result.outcomes.filter((o) => o.action === "proceed").map((o) => o.chunkNumber),
  ]);
  const buildable = added.filter((c) => c.dependsOn.every((d) => landed.has(d) || added.some((a) => a.number === d)));
  if (buildable.length === 0) return null;
  return { plan: { ...grown, chunks: [...opts.plan.chunks, ...buildable] }, chunks: buildable };
}

/**
 * Build what the plan gained this run, after the plan's own chunks, and fold
 * the result into the run's. `build` runs chunks of `plan` from `startIdx` in
 * order (run.ts runChunksInOrder). Returns the plan the run ended with.
 */
export async function buildSplitOffs(
  opts: LoopOptions, result: LoopResult,
  build: (opts: LoopOptions, startIdx: number) => Promise<LoopResult>,
): Promise<{ result: LoopResult; plan: ParsedPlan }> {
  const grown = splitOffsToBuild(opts, result);
  if (!grown || opts.signal?.aborted) return { result, plan: opts.plan };
  const extra = await build({ ...opts, plan: grown.plan, landedChunks: [], skipWallProbe: true }, opts.plan.chunks.length);
  const halted = result.status === "halted" || extra.status === "halted";
  return {
    plan: grown.plan,
    result: {
      ...extra,
      status: halted ? "halted" : "complete",
      chunksCommitted: result.chunksCommitted + extra.chunksCommitted,
      haltReason: [result.haltReason, extra.haltReason].filter(Boolean).join("\n\n"),
      lastChunk: result.status === "halted" ? result.lastChunk : extra.lastChunk,
    },
  };
}

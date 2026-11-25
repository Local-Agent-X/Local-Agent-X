/**
 * Chunks a parallel build sets aside, and the ones that wait on them.
 *
 * One chunk failing its review used to halt the whole build before anything
 * in its batch merged: a chunk that had passed was thrown away with it, and
 * every chunk after it never ran (label-check, 2026-11-22, where chunk 4
 * passed three times and never landed). A chunk that is still not green after
 * its fix rounds is now SET ASIDE: its work is kept on its branch, the chunks
 * that passed land, and the build goes on with everything that does not
 * depend on it. A chunk that does depend on it (directly or through another)
 * is not started; it WAITS, named with what it waits on.
 *
 * A build that set anything aside does not end "complete": it ends halted,
 * with what landed, what was set aside and why, and what waits. The landed
 * chunks are on record (orchestrator/state.ts landedChunks), so the resume
 * builds only what is left.
 */
import type { ParsedChunk } from "../plan-parser.js";
import type { EmitFn, LoopEvent, LoopResult } from "./types.js";
import type { BuildLeadRef } from "../advisor/lead-chat.js";
import { askLeadBuildCall } from "../advisor/lead-decisions.js";

/** Chunks set aside in one run before the build asks whether to keep trying:
 *  past this it is no longer about one chunk, and each one costs its fix
 *  rounds. Without a lead, the build stops here. */
export const MAX_SET_ASIDE = 3;

export interface SetAsideChunk {
  chunk: number;
  title: string;
  /** Why it is not green, in the review's words. */
  reason: string;
  /** The branch its work was kept on, when there was work to keep. */
  branch?: string;
}

export interface WaitingChunk {
  chunk: number;
  title: string;
  /** The set-aside or waiting chunk it depends on. */
  on: number;
}

export interface SetAsideLedger {
  setAside: SetAsideChunk[];
  waiting: WaitingChunk[];
  /** The set-aside count the build's lead said to build on past. */
  goOnThrough?: number;
}

export function createSetAsideLedger(): SetAsideLedger {
  return { setAside: [], waiting: [] };
}

export function anythingSetAside(ledger: SetAsideLedger): boolean {
  return ledger.setAside.length > 0 || ledger.waiting.length > 0;
}

/**
 * Whether the run stops now for the chunks it set aside. Past MAX_SET_ASIDE the
 * build's lead decides, and is asked again for each further one; a build with
 * no lead, or a lead that does not answer, stops, as every build used to.
 */
export async function stopForSetAside(
  ledger: SetAsideLedger,
  at: { chunkNumber: number; totalChunks: number; lead?: BuildLeadRef; signal?: AbortSignal; emit: EmitFn },
  ask: typeof askLeadBuildCall = askLeadBuildCall,
): Promise<boolean> {
  const n = ledger.setAside.length;
  if (n < MAX_SET_ASIDE || n <= (ledger.goOnThrough ?? 0)) return false;
  if (!at.lead) return true;
  const decision = await ask(at.lead, {
    kind: "set-aside-cap",
    title: `${n} chunks are set aside this run`,
    evidence: ledger.setAside.map((c) => `- chunk ${c.chunk} (${c.title}): ${oneLine(c.reason, 400)}`).join("\n") +
      (ledger.waiting.length ? `\nWaiting on them: ${ledger.waiting.map((w) => `chunk ${w.chunk}`).join(", ")}.` : ""),
    answers: {
      continue: "keep building the chunks that do not depend on them; you are asked again if another is set aside",
      park: "stop the build now; the owner is told what landed, what was set aside and why (say what they must decide in `question`)",
    },
    chunkNumber: at.chunkNumber, totalChunks: at.totalChunks,
  }, { signal: at.signal });
  if (decision?.action !== "continue") return true;
  ledger.goOnThrough = n;
  at.emit({ type: "push-back", chunkNumber: at.chunkNumber, totalChunks: at.totalChunks, message: `build lead: building on past ${n} set-aside chunks — ${decision.reasoning}` });
  return false;
}

/** The chunk `chunk` depends on that is set aside or itself waiting, if any. */
export function blockedOn(ledger: SetAsideLedger, chunk: ParsedChunk): number | undefined {
  const out = new Set([...ledger.setAside.map((c) => c.chunk), ...ledger.waiting.map((c) => c.chunk)]);
  return chunk.dependsOn.find((dep) => out.has(dep));
}

/** Split a batch into the chunks that can build and the ones that must wait,
 *  recording the latter. A chunk waits when one it depends on did not land. */
export function holdBackWaiting(ledger: SetAsideLedger, batch: ParsedChunk[]): { buildable: ParsedChunk[]; held: WaitingChunk[] } {
  const buildable: ParsedChunk[] = [];
  const held: WaitingChunk[] = [];
  for (const chunk of batch) {
    const on = blockedOn(ledger, chunk);
    if (on === undefined) { buildable.push(chunk); continue; }
    const waiting = { chunk: chunk.number, title: chunk.title, on };
    ledger.waiting.push(waiting);
    held.push(waiting);
  }
  return { buildable, held };
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What the build tells its chat when it ends with chunks set aside. */
export function setAsideSummary(ledger: SetAsideLedger, landed: number[]): string {
  const parts = [`The build went as far as it could: ${ledger.setAside.length} chunk(s) set aside, the rest built on without them.`];
  parts.push(landed.length ? `Landed this run: ${landed.map((n) => `chunk ${n}`).join(", ")}.` : "Nothing landed this run.");
  for (const c of ledger.setAside) {
    parts.push(`Set aside — chunk ${c.chunk} (${c.title}): ${oneLine(c.reason, 500)}${c.branch ? ` Its work is on branch '${c.branch}'.` : ""}`);
  }
  if (ledger.waiting.length) {
    parts.push(`Not started, waiting on those: ${ledger.waiting.map((w) => `chunk ${w.chunk} (on ${w.on})`).join(", ")}.`);
  }
  parts.push(
    "Resume to have each set-aside chunk picked up from its branch with what was found; chunks that landed are not built again. " +
    "A finding is fixed in the code: the plan changes only for a decision of the owner's, or to settle two of its own lines that contradict each other.",
  );
  return parts.join("\n");
}

/** End a run that set chunks aside: halted, saying what landed and what did not. */
export function endWithSetAside(
  ledger: SetAsideLedger,
  landed: number[],
  run: { chunksCommitted: number; totalChunks: number; emit: EmitFn; events: LoopEvent[]; outcomes: LoopResult["outcomes"] },
): LoopResult {
  const reason = setAsideSummary(ledger, landed);
  const at = ledger.setAside[0]?.chunk ?? ledger.waiting[0].chunk;
  run.emit({ type: "halt", chunkNumber: at, totalChunks: run.totalChunks, message: reason });
  return { status: "halted", lastChunk: at, chunksCommitted: run.chunksCommitted, haltReason: reason, outcomes: run.outcomes, events: run.events };
}

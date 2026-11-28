/**
 * Telling the chat that started a build how it ended, so its agent picks the
 * run back up at once instead of polling for it.
 *
 * The build's end was only a UI event (bg_op_completed) that the model never
 * saw, so an agent told to see the build through ran `sleep` and `git log` in
 * a loop, holding its turn for the whole run (label-check, 2026-11-21). Now
 * the result goes into the chat's pending queue, which its next prompt drains,
 * and the chat is woken to act on it (ops/op-report-wake.ts, the wake every
 * background job uses). A chat mid-turn is woken when that turn ends.
 *
 * The queue shows a notice's first 180 characters, so the notice leads with
 * what the agent must act on (how far the run got, why it stopped) and names
 * the call that has the rest.
 *
 * That chat is the build's lead (auto-build/advisor/lead-chat.ts): it made the
 * build's calls, and the decisions are on record in spec/build-state.md. So
 * it writes the run's ledger, as /greenfield ends a build with one, and tells
 * the owner what is theirs: the checks owed to them, the questions parked for
 * them (LEDGER_STEP). The engine first asks it for the entry and writes it
 * (lead-ledger.ts); the notice then only asks it to tell the owner.
 */
import { leadIsAttached, postToLead } from "../advisor/lead-channel.js";
import { nameFinishFixes } from "../finish-gates/fix-chunk.js";
import type { ParsedChunk } from "../plan-parser.js";
import { basename } from "node:path";
import { pushPendingNotification } from "../../ops/pending-notifications.js";
import { announceEndedOp } from "../../ops/op-report-wake.js";

export interface BuildEnd {
  sessionId: string;
  opId: string;
  projectDir: string;
  chunksCommitted: number;
  totalChunks: number;
  /** Set when the run stopped short: the chunk it stopped at, and why. */
  halt?: { chunk: number; reason: string };
  filesChanged: string[];
  /** What the finish gates left open (finish-gates/run.ts): named to the
   *  chat, so a "complete" build is never read as checked and seen working. */
  openItems?: string[];
  /** The lead's ledger entry for this run is already in spec/ledger.md (lead-ledger.ts). */
  ledgerWritten?: boolean;
  /** This run's finish fixes, named by title in what the chat reads. */
  finishFixes?: readonly Pick<ParsedChunk, "number" | "title">[];
}

/** The ledger step, or what is left of it once the lead's entry is written. */
function ledgerStep(end: BuildEnd): string {
  return end.ledgerWritten
    ? "Your ledger entry for this run is in spec/ledger.md. Tell the owner what is theirs to do or decide, if you have not."
    : LEDGER_STEP;
}

/** A project folder spelled with forward slashes, whichever computer wrote
 *  it: the spelling a tool call takes, and the one `basename` splits on every
 *  platform (on Linux it does not split a Windows path at "\\"). */
function portablePath(dir: string): string {
  return dir.replace(/\\/g, "/");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What the lead does with every build's end, whatever it was. */
export const LEDGER_STEP =
  "As the build's lead, record this run in spec/ledger.md: what landed, what did not and why, and the " +
  "follow-ups, checks owed to the owner and engine checks overruled that spec/build-state.md has from this run. " +
  "Then tell the owner, in a few lines, what is theirs to do or decide.";

/** The notice's two lines: what happened, and what to call next. */
export function buildEndNotice(end: BuildEnd): { summary: string; next: string } {
  const dir = JSON.stringify(portablePath(end.projectDir));
  const landed = `${end.chunksCommitted}/${end.totalChunks} chunks landed.`;
  if (!end.halt) {
    if (!end.openItems?.length) return { summary: `${landed} The build finished.`, next: `${ledgerStep(end)} Then carry on with the step that follows the build.` };
    return {
      summary: `${landed} The build finished; the finish checks left ${end.openItems.length} open item(s).`,
      next: `Open items:\n${end.openItems.map((i) => `- ${oneLine(i)}`).join("\n")}\n` +
        "Fix what is yours to fix, park for the owner what is theirs, and tell the owner the rest. Do not call the app done while any is open.\n" +
        ledgerStep(end),
    };
  }
  return {
    summary: `${landed} Halted at chunk ${end.halt.chunk}: ${oneLine(end.halt.reason)}`,
    next:
      `build_plan_status(project_dir=${dir}) has the full halt reason. Fix what halted it, or park it for the owner ` +
      `if it is theirs to decide, then build_plan_resume(project_dir=${dir}). Before that: ${ledgerStep(end)}`,
  };
}

export function reportBuildToChat(end: BuildEnd): void {
  const task = `The build of ${basename(portablePath(end.projectDir))} (run_build_plan)`;
  const status = end.halt ? "failed" : "completed";
  const named = (t: string) => nameFinishFixes(t, end.finishFixes ?? []);
  const raw = buildEndNotice(end);
  const notice = { summary: named(raw.summary), next: named(raw.next) };
  const wakeChat = () => {
    pushPendingNotification(end.sessionId, {
      opId: end.opId, status, summary: notice.summary, filesChanged: end.filesChanged, task,
      completedAt: Date.now(), toolJob: { next: notice.next },
    });
    announceEndedOp(end.sessionId, { opId: end.opId, task, status }, false);
  };
  // A lead driving the build from its turn reads the end there (build_next);
  // the chat is woken only if that turn ends without taking it.
  if (leadIsAttached(end.sessionId)) postToLead(end.sessionId, { kind: "ended", text: `${task} has ended. ${notice.summary}\n${notice.next}`, undelivered: wakeChat });
  else wakeChat();
}

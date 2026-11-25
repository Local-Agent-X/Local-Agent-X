/**
 * The build's ledger, written by its lead when a run ends: what landed, what
 * did not and why, what the owner must do or decide. /greenfield ends a build
 * with one; the engine's end-of-run summary was a list of chunk numbers.
 *
 * The engine hands the lead (the chat that started the build, advisor/
 * lead-chat.ts) the run's record: how it ended, the chunks that landed, the
 * finish checks' open items, and the decisions on record in
 * spec/build-state.md (accepts with follow-ups, checks owed to the owner,
 * engine checks overruled, splits). The lead answers with its report, and the
 * engine appends it to spec/ledger.md and commits it. A lead that does not
 * answer leaves the ledger to the chat's own turn at the end-of-build notice
 * (report-to-chat.ts LEDGER_STEP).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askLeadBuildCall } from "../advisor/lead-decisions.js";
import { canHaveLead } from "../advisor/lead-chat.js";
import { gitAdd, gitCommit } from "../git-helpers.js";
import type { LoopResult } from "../loop/types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("auto-build.lead-ledger");

/** How long the end of a run waits for the lead's report. */
const REPORT_ANSWER_MS = 5 * 60_000;
/** How much of spec/build-state.md the lead is shown: its latest decisions. */
const BUILD_STATE_TAIL = 8_000;

export interface LedgerInput {
  projectDir: string;
  originSessionId: string;
  result: LoopResult;
  /** Chunks this run landed. */
  landed: number[];
  totalChunks: number;
  /** Test seams. */
  ask?: typeof askLeadBuildCall;
  answerMs?: number;
}

function runRecord(input: LedgerInput): string {
  const { result } = input;
  const statePath = join(input.projectDir, "spec", "build-state.md");
  const state = existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";
  return [
    result.status === "complete" ? "The run finished." : `The run stopped at chunk ${result.lastChunk}: ${result.haltReason}`,
    `Chunks this run landed: ${input.landed.length ? input.landed.join(", ") : "none"} (the plan has ${input.totalChunks}).`,
    ...(result.openItems?.length ? [`Open items the finish checks left:\n${result.openItems.map((i) => `- ${i}`).join("\n")}`] : []),
    state ? `The build's decisions on record (spec/build-state.md, latest last):\n${state.slice(-BUILD_STATE_TAIL)}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Ask the lead for this run's report and write it to spec/ledger.md; false
 *  when there is no lead or it gave no report. */
export async function writeLeadLedger(input: LedgerInput): Promise<boolean> {
  if (!canHaveLead(input.originSessionId)) return false;
  const decision = await (input.ask ?? askLeadBuildCall)({ projectDir: input.projectDir, originSessionId: input.originSessionId }, {
    kind: "report",
    title: "The build run ended: its ledger entry",
    evidence: runRecord(input),
    answers: {
      accept: "your report, in `report`, is added to spec/ledger.md for this run: what was built, what did not land and " +
        "why, the follow-ups, and what the owner must do or decide (checks owed to them, questions parked for them)",
    },
    chunkNumber: input.result.lastChunk, totalChunks: input.totalChunks,
  }, { answerMs: input.answerMs ?? REPORT_ANSWER_MS });
  const report = decision?.report?.trim();
  if (!report) return false;
  const path = join(input.projectDir, "spec", "ledger.md");
  const entry = `\n\n## Build run, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC (written by the build lead)\n\n${report}\n`;
  try {
    if (existsSync(path)) appendFileSync(path, entry);
    else writeFileSync(path, `# Build ledger${entry}`);
    await gitAdd(input.projectDir, "spec/ledger.md");
    await gitCommit(input.projectDir, "spec: the build lead's ledger entry for this run");
  } catch (e) {
    logger.warn(`ledger entry for ${input.projectDir} not written: ${(e as Error).message}`);
    return false;
  }
  return true;
}

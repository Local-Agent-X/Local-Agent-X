/**
 * Gate 1: Done-when verifier (split from gates.ts —
 * this gate plus its missing-credentials coupling is the largest single gate).
 *
 * Failure modes detected mechanically:
 *
 *  (a) STATUS != "done" → chunk explicitly didn't ship → push_back. Missing
 *      third-party credentials carry their recovery (placeholder envs +
 *      LAUNCH_READINESS deferral, missing-creds.ts); a named spec gap goes to
 *      the advisor to amend; anything else goes back with STUCK_RECOVERY.
 *      Never a halt from here: the push-back advisor (loop/handle-push-back.ts)
 *      is the one that stops a build, for a decision only the owner can make.
 *  (b) DONE_WHEN == "unmet" or "unknown" → push_back, the same way
 *  (c) DONE_WHEN == "deferred-to-launch-readiness" but the chunk's
 *      plan-level done-when names an "integration test" or specific
 *      observable behavior (not a launch-time concern) → push_back: run it;
 *      this is the chunk-6 silent-deferral pattern. EXCEPTIONS: a deferral
 *      the done-when itself orders (it names LAUNCH_READINESS or "before
 *      launch"), and one whose LAUNCH_READINESS names the missing
 *      credentials; gateLaunchReadiness still enforces concreteness.
 *  (d) STATUS == "done", DONE_WHEN == "met", BUT the NOTE body contains
 *      a contradictory phrase ("deferred", "stub", "todo", "follow up",
 *      "didn't run") indicating the structured field is too optimistic
 *      → push_back: run it. This catches the chunk-6 case even when the agent
 *      mis-fills the structured field.
 */

import type { ParsedChunk } from "../plan-parser.js";
import type { ChunkReport } from "./report-parser.js";
import { workerWords } from "./report-parser.js";
import { CRED_TERM, mentionsMissingCreds, MISSING_CREDS_RECOVERY } from "./missing-creds.js";
import type { GateFinding } from "./gates.js";

export function gateDoneWhen(chunk: ParsedChunk, report: ChunkReport): GateFinding | null {
  if (report.status === "blocked" || report.status === "partial") {
    // Missing third-party credentials are a RECOVERABLE condition, not a
    // user-attention halt: the sanctioned path is placeholder envs + a
    // LAUNCH_READINESS deferral (live failure 2026-07-02: chunk 2 halted on
    // "Build fails solely on missing Supabase credentials" and the user had
    // to type the recovery instruction by hand). Retry once with it instead.
    if (mentionsMissingCreds(`${report.note} ${report.specGaps}`)) {
      return {
        gate: "done-when",
        action: "push_back",
        reasoning: MISSING_CREDS_RECOVERY + workerWords(report),
      };
    }
    // A worker that names a concrete spec gap has done exactly what the
    // discipline prompt asked: stop rather than guess. Route it through the
    // bounded push-back advisor, which can amend additively and RETRY the same
    // chunk. The old halt made the advertised spec-recovery path unreachable.
    if (report.specGaps.trim()) {
      return {
        gate: "done-when",
        action: "push_back",
        reasoning:
          `Chunk reported STATUS=${report.status} with an explicit SPEC_GAPS entry. ` +
          `Ask the build advisor whether the gap is safely additive; if so amend the spec and retry this chunk, ` +
          `otherwise halt for a real product decision.${workerWords(report)}`,
      };
    }
    // A worker that stopped is not a build that must stop. label-check-sol's
    // chunk 1 worker lost the phone over ADB, reported partial, and the whole
    // build halted for "user attention" (2026-11-24): what it needed was the
    // instruction to defer the device run, which the push-back carries.
    return {
      gate: "done-when",
      action: "push_back",
      reasoning: `Chunk reported STATUS=${report.status}. ${STUCK_RECOVERY}${workerWords(report)}`,
    };
  }

  if (report.doneWhen === "unmet" || report.doneWhen === "unknown") {
    return {
      gate: "done-when",
      action: "push_back",
      reasoning: `Chunk reported DONE_WHEN=${report.doneWhen}; done-when is the chunk's contract. ${STUCK_RECOVERY}${workerWords(report)}`,
    };
  }

  // (c) Silent deferral pattern — see the header. A deferral passes when the
  // plan itself orders it (the done-when names launch-readiness: "report this
  // in LAUNCH_READINESS … run before launch") or when LAUNCH_READINESS names
  // the missing credentials; gateLaunchReadiness still enforces concreteness.
  // Any other deferral of a check the worker can run goes BACK to the worker
  // to run it: setting the chunk aside on the spot threw away label-check's
  // chunk 7, deferred because its plan said to, three runs in a row, and its
  // chunk 9, whose worker had run and passed every check it named
  // (2026-11-22).
  if (report.doneWhen === "deferred-to-launch-readiness") {
    const isMechanicalContract = /\b(integration test|unit test|asserts?|returns?|test|passes?)\b/i.test(chunk.doneWhen);
    if (isMechanicalContract && !planOrdersDeferral(chunk.doneWhen) && !CRED_TERM.test(report.launchReadiness)) {
      return {
        gate: "done-when",
        action: "push_back",
        reasoning:
          `Chunk's done-when ("${truncate(chunk.doneWhen, 120)}") names a mechanical verification, ` +
          `but the report defers it to launch-readiness (the silent-deferral pattern). ${RUN_IT_HERE}${workerWords(report)}`,
      };
    }
  }

  // (d) NOTE contradicts the structured field. Common Bookwell shape:
  // "DONE_WHEN: met" but NOTE says "the integration test is launch-readiness
  // deferred." That's the chunk-6 incident in a single check.
  if (report.doneWhen === "met") {
    const note = report.note.toLowerCase();
    const contradictoryPhrases = [
      "deferred to launch-readiness",
      "deferred-to-launch",
      "launch-readiness deferred",
      "integration test is launch-readiness",
      "didn't run the test",
      "did not run the test",
      "wasn't able to run",
      "test was skipped",
      "skipped the test",
    ];
    for (const phrase of contradictoryPhrases) {
      if (note.includes(phrase)) {
        return {
          gate: "done-when",
          action: "push_back",
          reasoning:
            `Report says DONE_WHEN: met but NOTE contains "${phrase}": the structured field contradicts the prose ` +
            `(a silent deferral). ${RUN_IT_HERE}`,
        };
      }
    }
  }

  return null;
}

/** What a worker that stopped short is sent back to do. Whether the chunk then
 *  needs the owner is the push-back advisor's call, never this gate's. */
const STUCK_RECOVERY =
  `Finish what can be done on this machine: the code, the tests, the build. What truly cannot run here ` +
  `(a phone or emulator that is not reachable, a third-party account or credential this machine does not ` +
  `have) goes in LAUNCH_READINESS with how to verify it, and the report says DONE_WHEN: ` +
  `deferred-to-launch-readiness. A product or design question only the owner can answer goes in SPEC_GAPS, ` +
  `stated as the choice to make, and you build the safest option meanwhile.`;

/** What the worker is sent back to do about a deferral it was not told to make. */
const RUN_IT_HERE =
  `Run every check the done-when names that can run on this machine (tests, builds, compiles, a public API call) ` +
  `and report DONE_WHEN: met once they pass. Put in LAUNCH_READINESS only what truly cannot run here (a real ` +
  `device, a third-party account or credential this machine does not have), each with how to verify it.`;

/** The plan's own done-when tells the worker to leave part of it for launch:
 *  it names LAUNCH_READINESS, or a check run "before launch". */
function planOrdersDeferral(doneWhen: string): boolean {
  return /\bLAUNCH[_ -]READINESS\b|\bbefore launch\b/i.test(doneWhen);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

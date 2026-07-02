/**
 * Gate 1: Done-when verifier (split from gates.ts at the 400-LOC ceiling —
 * this gate plus its missing-credentials coupling is the largest single gate).
 *
 * Failure modes detected mechanically:
 *
 *  (a) STATUS != "done" → chunk explicitly didn't ship → halt, EXCEPT a
 *      block whose own words name missing third-party credentials — that is
 *      recoverable (placeholder envs + LAUNCH_READINESS deferral) and gets a
 *      push_back carrying the recovery instruction (missing-creds.ts).
 *  (b) DONE_WHEN == "unmet" or "unknown" → halt
 *  (c) DONE_WHEN == "deferred-to-launch-readiness" but the chunk's
 *      plan-level done-when names an "integration test" or specific
 *      observable behavior (not a launch-time concern) → halt; this is
 *      the chunk-6 silent-deferral pattern. EXCEPTION: a deferral whose
 *      LAUNCH_READINESS names the missing credentials is the sanctioned
 *      missing-creds path; gateLaunchReadiness still enforces concreteness.
 *  (d) STATUS == "done", DONE_WHEN == "met", BUT the NOTE body contains
 *      a contradictory phrase ("deferred", "stub", "todo", "follow up",
 *      "didn't run") indicating the structured field is too optimistic
 *      → halt. This catches the chunk-6 case even when the agent
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
    return {
      gate: "done-when",
      action: "halt",
      reasoning: `Chunk reported STATUS=${report.status}; needs user attention before continuing.${workerWords(report)}`,
    };
  }

  if (report.doneWhen === "unmet" || report.doneWhen === "unknown") {
    return {
      gate: "done-when",
      action: "halt",
      reasoning: `Chunk reported DONE_WHEN=${report.doneWhen}. Done-when is the chunk's correctness contract — cannot proceed.${workerWords(report)}`,
    };
  }

  // (c) Silent deferral pattern — see the header. The cred carve-out lets a
  // deferral through only when LAUNCH_READINESS names the credentials.
  if (report.doneWhen === "deferred-to-launch-readiness") {
    const isMechanicalContract = /\b(integration test|unit test|asserts?|returns?|test|passes?)\b/i.test(chunk.doneWhen);
    if (isMechanicalContract && !CRED_TERM.test(report.launchReadiness)) {
      return {
        gate: "done-when",
        action: "halt",
        reasoning:
          `Chunk's done-when ("${truncate(chunk.doneWhen, 120)}") names a mechanical verification, ` +
          `but the report defers it to launch-readiness. This is the silent-deferral pattern — halt and surface to the user.`,
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
          action: "halt",
          reasoning:
            `Report says DONE_WHEN: met but NOTE contains "${phrase}". ` +
            `The structured field contradicts the prose — treat this as a silent deferral and halt.`,
        };
      }
    }
  }

  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

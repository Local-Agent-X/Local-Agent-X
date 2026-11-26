/**
 * The worker's own word that the chunk is not finished.
 *
 * A worker reports `blocked`, `partial` or done-when `unmet` through a typed
 * field of `chunk_report`: no prose is read to find it. That is a claim, not a
 * measurement, so it goes to whoever judges claims: the build's lead, or the
 * push-back advisor when the build has none (loop/handle-push-back.ts). They
 * decide whether it goes back to a worker, lands with a check owed, or waits
 * for the owner. Never a halt from here.
 *
 * A worker that reported nothing is not sent back for that: the review moves
 * on to what it measures (the build and tests, the held-out scenarios, the
 * skeptic).
 *
 * What this gate no longer does: guess from the wording of the note that
 * credentials are missing, that a deferral was the wrong call, or that "met"
 * was optimistic. Each of those guesses held a chunk on how a sentence was put.
 * Whether the done-when is met is what the scenarios and the skeptic judge.
 */

import { workerWords, type ChunkReport } from "./chunk-report.js";
import type { GateFinding } from "./gates.js";

export function gateDoneWhen(report: ChunkReport): GateFinding | null {
  if (!report.reported) return null;
  // A worker that met its done-when and still says partial is waiting on what
  // the engine does next: the build check, the skeptic, the held-out judge.
  // label-check-sol's chunk 1 worker had run the app on an emulator and passed
  // every check, then reported partial because it could not "dispatch a
  // skeptic"; that push-back spent the chunk's last fix round (2026-11-24).
  const metButPartial = report.status === "partial" && report.doneWhen === "met";
  const stopped = report.status === "blocked" || (report.status === "partial" && !metButPartial) || report.doneWhen === "unmet";
  if (!stopped) return null;
  const said = `The worker reports ${report.status}, done-when ${report.doneWhen}`;

  // What this machine refused is nobody's to fix in the build. The same
  // finding the build check raises when it sees a refusal itself, so it takes
  // the same road: the lead, or the owner when there is no lead.
  if (report.machineBlocked.length > 0) {
    const [first] = report.machineBlocked;
    return {
      gate: "build-refused", action: "push_back",
      refused: { command: first.check, what: `by the worker's account, ${first.reason}` },
      reasoning:
        `${said}, and says this machine refused to run: ` +
        `${report.machineBlocked.map((b) => `\`${b.check}\` (${b.reason})`).join("; ")}. ` +
        `No worker can change the machine.${workerWords(report)}`,
    };
  }
  return { gate: "done-when", action: "push_back", reasoning: `${said}: the chunk is not finished. ${STUCK_RECOVERY}${workerWords(report)}` };
}

/** What a worker that stopped short is sent back to do. Whether the chunk then
 *  needs the owner is the lead's or the advisor's call, never this gate's.
 *  A worker that lost its phone over ADB reported partial and the whole build
 *  halted for "user attention" (label-check-sol, 2026-11-24): what it needed
 *  was this. Missing credentials are covered here for every stopped worker,
 *  where a regex over its note used to decide whether to say so. */
const STUCK_RECOVERY =
  `Finish what can be done on this machine: the code, the tests, the build. ` +
  `What truly cannot run here (a phone or emulator that is not reachable, a third-party account this machine ` +
  `does not have) goes in chunk_report's launch_readiness with how to verify it, and done_when is "deferred". ` +
  `Missing third-party credentials are never a blocker: put plain, clearly fake placeholder values in the ` +
  `framework's local env file (low-entropy words like "placeholder-anon-key", never a realistic-looking token), ` +
  `make the build and dev boot succeed without the real service, and list each real credential's setup in ` +
  `launch_readiness, naming the exact variables. A command this machine itself refuses to run (an ` +
  `operating-system or policy block) goes in machine_blocked with what it printed. A product or design ` +
  `question only the owner can answer goes in owner_question, and you build the safest option meanwhile.`;

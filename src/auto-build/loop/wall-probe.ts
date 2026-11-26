/**
 * The wall probe: before a build with a sealed scenario suite goes on past its
 * first landed chunk, prove the judge can start the app and reach a verdict.
 *
 * Every later judging depends on it. label-check's never could (a launch file
 * it could not read, then a judge whose replies did not parse and a page
 * behind a bot check), and all thirteen chunks landed with nothing scored
 * (2026-11-23). A probe after the first landed chunk finds that out while one
 * chunk is built, not thirteen.
 *
 * One sealed scenario, scored on the base the way a phase gate is. Its score
 * does not matter, only that there is one: a pass or a failure proves the
 * harness works; an app the judge cannot start or a scenario it cannot judge
 * halts the build with the reason. With no launch file yet (the foundation may
 * write it later) the probe waits for the next landed chunk, and says so once.
 * A project with no sealed suite has nothing to probe.
 *
 * A build with a lead asks it first: when what the judge lacks is something
 * only the owner has (a device, an account), the lead can call the check owed
 * and the build goes on, every chunk's scenarios unjudged and said so, with
 * the owner asked at the end. A lead that parks, or does not answer, halts.
 */

import { basename, join } from "node:path";
import { listScenarios } from "../../holdout/store.js";
import { projectHoldoutDir } from "../../holdout/paths.js";
import { leavingTrackedFilesAsFound } from "../git-helpers.js";
import { appendHalt, recordOwed } from "../failure-recovery.js";
import { readLaunchSpec } from "../scenario-scorer/launch-spec.js";
import { scoreScenarioFiles } from "../scenario-scorer/phase-gate-runner.js";
import { isUnjudged } from "../scenario-scorer/types.js";
import { applyAdditiveSpecAmendment, commitSpecAmendment } from "../loop-effects.js";
import { askLeadBuildCall } from "../advisor/lead-decisions.js";
import type { PhasePauseScope, PhaseScoreResult } from "./phase-gate-pause.js";
import { safeGet, type LoopOptions } from "./types.js";

type ProbeOptions = Pick<LoopOptions, "projectDir" | "signal" | "skipWallProbe" | "buildLead"> & { plan?: LoopOptions["plan"] };

/** The lead's word on a judge that cannot check the app: the check owed (go
 *  on), or null to halt. */
async function owedByLead(opts: ProbeOptions, scope: PhasePauseScope, chunkNumber: number, why: string, ask: typeof askLeadBuildCall): Promise<string | null> {
  if (!opts.buildLead) return null;
  const decision = await ask(opts.buildLead, {
    kind: "wall-probe",
    title: "The judge cannot check this app",
    evidence: `Before the build goes on, the judge starts the app and judges one sealed scenario, to prove every later chunk can be judged. It could not: ${why}`,
    answers: {
      owed: "build on: every chunk from here lands with its held-out scenarios unjudged, said so in the report, and the check is owed to the owner (say what it needs in owed_check)",
      park: "stop the build: the owner fixes the launch file, the app's test mode or the judge's setup, then resumes (say what in question)",
    },
    chunkNumber, totalChunks: scope.totalChunks,
  }, { signal: opts.signal });
  if (decision?.action !== "owed") return null;
  const chunk = opts.plan?.chunks.find((c) => c.number === chunkNumber);
  if (chunk) {
    const amended = await applyAdditiveSpecAmendment(opts.projectDir, chunk, `The judge's check is owed to the owner: ${decision.owedCheck}\nWhy the judge could not check the app: ${why}\nThe build lead's call: ${decision.reasoning}`);
    if (amended.ok) await safeGet(() => commitSpecAmendment(opts.projectDir, chunk));
  }
  return decision.owedCheck!;
}

export interface WallProbe {
  /** After a chunk lands on the base: probe once, if not proven yet. */
  afterLanding(scope: PhasePauseScope, chunkNumber: number, chunksCommitted: number): Promise<PhaseScoreResult>;
}

export function createWallProbe(opts: ProbeOptions, ask: typeof askLeadBuildCall = askLeadBuildCall): WallProbe {
  const project = basename(opts.projectDir);
  const suite = listScenarios(project);
  const dir = projectHoldoutDir(project);
  let proven = Boolean(opts.skipWallProbe) || suite.length === 0 || !dir;
  let saidWaiting = false;

  return {
    async afterLanding(scope, chunkNumber, chunksCommitted) {
      if (proven || opts.signal?.aborted) return { kind: "ok" };
      const say = (message: string) => scope.emit({ type: "review-result", chunkNumber, totalChunks: scope.totalChunks, message });
      const read = readLaunchSpec(opts.projectDir);
      if (read.kind !== "ok") {
        if (!saidWaiting) say(`judge check waits: ${read.kind === "invalid" ? read.reason : "the project has no .lax-launch.json yet"}`);
        saidWaiting = true;
        return { kind: "ok" };
      }
      proven = true;
      say(`judge check: starting the app and judging ${suite[0]} before the rest of the build`);
      const { value: outcome } = await leavingTrackedFilesAsFound(opts.projectDir, () => scoreScenarioFiles({
        projectDir: opts.projectDir, launch: read.spec, scenarioPaths: [join(dir!, suite[0])], signal: opts.signal,
        onProgress: (m) => say(`[judge check] ${m}`),
      }));
      if (opts.signal?.aborted) return { kind: "ok" };
      const why = outcome.kind === "error" || outcome.kind === "no-spec" ? outcome.reason
        : outcome.kind === "unjudged" ? `${suite[0]} could not be judged twice: ${outcome.unjudgedReports[0]?.abortReason}` : null;
      if (!why) {
        const report = outcome.kind === "proceed" || outcome.kind === "failures" ? outcome.reports[0] : undefined;
        say(`judge check passed: the judge started the app and scored ${suite[0]}${report && !isUnjudged(report) ? ` (${report.score}/10)` : ""}`);
        return { kind: "ok" };
      }
      // This machine's or the judge's own trouble starting the app is nobody's
      // to fix in the build: owed, without stopping to ask. Anything else (the
      // app would not start, the launch file is wrong) is the lead's call.
      const machines = outcome.kind === "error" && outcome.harness === true;
      const owed = machines ? `the judge could not start the app on this machine: ${why}` : await owedByLead(opts, scope, chunkNumber, why, ask);
      if (owed) {
        recordOwed(opts.projectDir, { check: "judge check", why: `the held-out scenarios are unjudged from chunk ${chunkNumber} on: ${owed}` });
        say(`judge check owed to the owner, the build goes on with scenarios unjudged: ${owed}`);
        return { kind: "ok" };
      }
      const reason = `The judge cannot check this app, so every chunk from here would land unverified: ${why}. ` +
        "Fix that (the launch file, the app's test mode, or the judge's setup), then resume the build.";
      scope.emit({ type: "halt", chunkNumber, totalChunks: scope.totalChunks, message: reason });
      appendHalt(opts.projectDir, { chunk: chunkNumber, gate: "wall-probe", reason: reason.slice(0, 200) });
      return { kind: "halt", result: { status: "halted", lastChunk: chunkNumber, chunksCommitted, haltReason: reason, outcomes: scope.outcomes, events: scope.events } };
    },
  };
}

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
 */

import { basename, join } from "node:path";
import { listScenarios } from "../../holdout/store.js";
import { projectHoldoutDir } from "../../holdout/paths.js";
import { leavingTrackedFilesAsFound } from "../git-helpers.js";
import { appendHalt } from "../failure-recovery.js";
import { readLaunchSpec } from "../scenario-scorer/launch-spec.js";
import { scoreScenarioFiles } from "../scenario-scorer/phase-gate-runner.js";
import { isUnjudged } from "../scenario-scorer/types.js";
import type { PhasePauseScope, PhaseScoreResult } from "./phase-gate-pause.js";
import type { LoopOptions } from "./types.js";

export interface WallProbe {
  /** After a chunk lands on the base: probe once, if not proven yet. */
  afterLanding(scope: PhasePauseScope, chunkNumber: number, chunksCommitted: number): Promise<PhaseScoreResult>;
}

export function createWallProbe(opts: Pick<LoopOptions, "projectDir" | "signal" | "skipWallProbe">): WallProbe {
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
      const reason = `The judge cannot check this app, so every chunk from here would land unverified: ${why}. ` +
        "Fix that (the launch file, the app's test mode, or the judge's setup), then resume the build.";
      scope.emit({ type: "halt", chunkNumber, totalChunks: scope.totalChunks, message: reason });
      appendHalt(opts.projectDir, { chunk: chunkNumber, gate: "wall-probe", reason: reason.slice(0, 200) });
      return { kind: "halt", result: { status: "halted", lastChunk: chunkNumber, chunksCommitted, haltReason: reason, outcomes: scope.outcomes, events: scope.events } };
    },
  };
}

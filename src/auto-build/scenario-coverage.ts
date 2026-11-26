/**
 * Whether a plan can be judged against its project's sealed scenarios, read
 * before the build starts.
 *
 * A sealed scenario that no chunk names is scored by nothing until the very
 * end, and a project with no suite at all, or a plan with no phase gates, is
 * judged less than it looks. label-check's plan named scenarios on 2 of its 13
 * chunks; every chunk landed "not scored" and nobody was told (2026-11-23).
 * So an unassigned scenario refuses the run, and the rest is said once.
 *
 * A sealed scenario the judge cannot run refuses it too: two builds ran to
 * the end with every scenario a prose paragraph the judge skipped, each chunk
 * landing as "scenarios 0/0 passed" (2026-11-26).
 */

import { basename } from "node:path";
import { listScenarios, readScenariosForJudge } from "../holdout/store.js";
import { parseScenarioText } from "./scenario-scorer/parser.js";
import { scenarioNumbersOf } from "./scenario-scorer/phase-gate-runner.js";
import type { ParsedPlan } from "./plan-parser.js";

function numberOf(file: string): number | null {
  const n = Number((file.match(/^(\d+)/) || [])[1]);
  return Number.isFinite(n) ? n : null;
}

/** Why the plan cannot run as written, or null. Only an unassigned sealed
 *  scenario refuses it; fixing that costs the planner one edit. */
export function planCoverageProblem(projectDir: string, plan: ParsedPlan): string | null {
  const sealed = listScenarios(basename(projectDir));
  if (sealed.length === 0) return null;
  const named = scenarioNumbersOf(plan.chunks);
  const unassigned = sealed.filter((f) => { const n = numberOf(f); return n === null || !named.has(n); });
  if (unassigned.length === 0) return null;
  return `spec/plan.md gives ${unassigned.length} of the ${sealed.length} sealed scenarios to no chunk: ${unassigned.join(", ")}. ` +
    "A scenario no chunk names is never judged while the build runs. Add each number to the `Scenarios:` line of the chunk " +
    "after which it should pass (it is judged when the last chunk naming it lands), then run the plan again.";
}

/** What the run will not check, said once when it starts. Empty when nothing. */
export function planCoverageNotes(projectDir: string, plan: ParsedPlan): string[] {
  const notes: string[] = [];
  if (listScenarios(basename(projectDir)).length === 0) {
    notes.push("This project has no sealed scenario suite, so chunks are checked by their build, tests and the skeptic only.");
  }
  if (!plan.phaseGatesRawSection) {
    notes.push("spec/plan.md has no \"Phase verification gates\" section, so no phase is scored when it ends.");
  }
  return notes;
}

/** Why the judge cannot run this project's sealed suite, or null. File names
 *  only: a scenario's text never goes into a tool result. */
export function suiteDriveProblem(projectDir: string): string | null {
  const sealed = readScenariosForJudge(basename(projectDir));
  const stuck = sealed.filter((s) => {
    try { parseScenarioText(s.content, s.filename); return false; } catch { return true; }
  }).map((s) => s.filename);
  if (stuck.length === 0) return null;
  return `The build's judge cannot run ${stuck.length} of the ${sealed.length} sealed scenarios: ${stuck.join(", ")}. ` +
    "Each has no numbered `**Steps:**` list for the judge to perform, so it would be judged by nothing. " +
    "Write each again with holdout_write, same file name, in the shape that tool describes (a sealed scenario the judge " +
    "cannot run may be replaced), then run the plan again.";
}

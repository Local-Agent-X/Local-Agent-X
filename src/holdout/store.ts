/**
 * A project's held-out scenario suite: written by the chat that plans the build
 * (holdout_write), sealed once the owner has seen it (holdout_seal), and read
 * only by harness code that scores the running app (auto-build/scenario-scorer).
 *
 * Nothing here hands a scenario's text to a model tool result. The seal is a
 * marker file: after it, the suite cannot be added to or changed, so a build
 * that is going badly cannot rewrite its own test.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectHoldoutDir } from "./paths.js";

const SEAL_FILE = ".sealed";
const SCENARIO_FILE = /^[a-z0-9][a-z0-9._-]{0,79}\.md$/i;
/** One scenario is prose a person reads; anything this long is not one. */
export const SCENARIO_MAX_CHARS = 20_000;

export class HoldoutError extends Error {}

function dirOf(project: string): string {
  const dir = projectHoldoutDir(project);
  if (!dir) throw new HoldoutError(`"${project}" is not a project name: letters, digits, dot, dash or underscore.`);
  return dir;
}

export function isSealed(project: string): boolean {
  return existsSync(join(dirOf(project), SEAL_FILE));
}

/** Write (or replace) one scenario. Refused once the suite is sealed. */
export function writeScenario(project: string, filename: string, content: string): { replaced: boolean } {
  const dir = dirOf(project);
  if (!SCENARIO_FILE.test(filename)) throw new HoldoutError(`"${filename}" is not a scenario file name: a plain name ending in .md.`);
  if (!content.trim()) throw new HoldoutError("A scenario needs content.");
  if (content.length > SCENARIO_MAX_CHARS) throw new HoldoutError(`A scenario is at most ${SCENARIO_MAX_CHARS} characters.`);
  if (isSealed(project)) throw new HoldoutError(`The suite for "${project}" is sealed: scenarios can no longer be added or changed.`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  const replaced = existsSync(path);
  writeFileSync(path, content, "utf8");
  return { replaced };
}

/** Seal the suite. Refused when it holds no scenario. */
export function sealSuite(project: string): { scenarios: string[] } {
  const scenarios = listScenarios(project);
  if (scenarios.length === 0) throw new HoldoutError(`There are no scenarios for "${project}" to seal.`);
  writeFileSync(join(dirOf(project), SEAL_FILE), new Date().toISOString(), "utf8");
  return { scenarios };
}

/** The scenario file names, sorted: an index the planning chat may show. */
export function listScenarios(project: string): string[] {
  const dir = dirOf(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => SCENARIO_FILE.test(f)).sort();
}

/** Harness only: every scenario's path and text, for the judge. Never pass this to a tool result. */
export function readScenariosForJudge(project: string): Array<{ filename: string; path: string; content: string }> {
  const dir = dirOf(project);
  return listScenarios(project).map((filename) => {
    const path = join(dir, filename);
    return { filename, path, content: readFileSync(path, "utf8") };
  });
}

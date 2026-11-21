/**
 * Where a project's held-out acceptance scenarios live: `<data dir>/holdout/<project>/`.
 *
 * A build's scenarios are written before any code and scored against the running
 * app by a judge the building agents never are. They live outside the project,
 * the workspace and everything served, and no model tool call may touch this
 * folder (security/layer/holdout-seal.ts). Only harness code reads it.
 *
 * A leaf: the security layer imports it, so it depends on nothing but the data dir.
 */
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

/** Every project's suite sits under this folder. Resolved per call (the data dir may move). */
export function holdoutRoot(): string {
  return join(getLaxDir(), "holdout");
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A project's suite folder; null for a name that is not one plain folder name. */
export function projectHoldoutDir(project: string): string | null {
  if (!PROJECT_NAME.test(project) || project.includes("..")) return null;
  return join(holdoutRoot(), project);
}

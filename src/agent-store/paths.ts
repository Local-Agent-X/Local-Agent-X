// Shared paths for the agent-related JSON stores. Runs get one file per
// run under agent-runs/; templates, projects, and issues live in
// single-file stores in ~/.lax/.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export const runsDir = (): string => join(getLaxDir(), "agent-runs");
export const templatesFile = (): string => join(getLaxDir(), "agent-templates.json");
export const projectsFile = (): string => join(getLaxDir(), "agent-projects.json");
export const issuesFile = (): string => join(getLaxDir(), "agent-issues.json");

export function ensureDirs(): void {
  if (!existsSync(runsDir())) mkdirSync(runsDir(), { recursive: true });
}

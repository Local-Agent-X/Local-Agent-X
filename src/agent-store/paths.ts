// Shared paths for the agent-related JSON stores. Runs get one file per
// run under agent-runs/; templates, projects, and issues live in
// single-file stores in ~/.lax/.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export const RUNS_DIR = join(getLaxDir(), "agent-runs");
export const TEMPLATES_FILE = join(getLaxDir(), "agent-templates.json");
export const PROJECTS_FILE = join(getLaxDir(), "agent-projects.json");
export const ISSUES_FILE = join(getLaxDir(), "agent-issues.json");

export function ensureDirs(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

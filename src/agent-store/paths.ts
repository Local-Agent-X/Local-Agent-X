// Shared paths for the agent-related JSON stores. Runs get one file per
// run under agent-runs/; templates, projects, and issues live in
// single-file stores in ~/.lax/.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

export const LAX_DIR = getLaxDir();
export const RUNS_DIR = join(LAX_DIR, "agent-runs");
export const TEMPLATES_FILE = join(LAX_DIR, "agent-templates.json");
export const PROJECTS_FILE = join(LAX_DIR, "agent-projects.json");
export const ISSUES_FILE = join(LAX_DIR, "agent-issues.json");

export function ensureDirs(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

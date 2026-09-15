// The `agents-md` system-prompt section body: the repo-root AGENTS.md under an
// "## Invariants" heading, or "" when absent. Resolved from this file's
// location — tsc preserves directories, so dist/context/agents-md-section.js
// and src/context/agents-md-section.ts both reach the repo root two levels up.
// (A ".." here once injected src/AGENTS.md in dev and nothing in the compiled
// build; system-prompt-builder.test.ts pins the root file.)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function readAgentsMdSection(): Promise<string> {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const p = join(root, "AGENTS.md");
    if (!existsSync(p)) return "";
    return `## Invariants (AGENTS.md)
${readFileSync(p, "utf-8")}`;
  } catch {
    return "";
  }
}

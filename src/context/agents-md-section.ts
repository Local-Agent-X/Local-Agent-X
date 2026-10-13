// The `agent-rules` system-prompt section body: config/agent-rules.md under an
// "## Invariants" heading, or "" when absent. Resolved from this file's
// location — tsc preserves directories, so dist/context/agents-md-section.js
// and src/context/agents-md-section.ts both reach the install root two levels
// up. (A ".." here once injected src/AGENTS.md in dev and nothing in the
// compiled build; system-prompt-builder.test.ts pins the path.)
//
// This used to inject the repo-root AGENTS.md verbatim. That file is written
// for coding agents working ON the repo (Codex, Claude Code, self_edit), so
// ~65% of it — the tool-registration checklist, LOC rules, the Codex scope
// paragraph — reached the product agent every turn, and its "runtime state →
// HTTP API" lane contradicted the `setting` rule in system-prompt.md while
// outranking it (this section is never shed; that one is). The product agent's
// invariants now live in config/agent-rules.md, beside its prompt.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_RULES_RELATIVE_PATH = "config/agent-rules.md";

export async function readAgentRulesSection(): Promise<string> {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const p = join(root, AGENT_RULES_RELATIVE_PATH);
    if (!existsSync(p)) return "";
    return `## Invariants (agent-rules.md)
${readFileSync(p, "utf-8")}`;
  } catch {
    return "";
  }
}

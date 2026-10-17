/**
 * The guidance docs the structure kit writes into a project the agent builds:
 * rules (AGENTS.md), meaning (ARCHITECTURE.md), the first ADR and the history
 * folder's note. Filled in with the project's real commands and paths — a
 * placeholder left in a guidance doc is a stale claim on day one, and the
 * project's own doc-path check would fail on it.
 */
import { STRUCTURE_CHECK_COMMAND } from "./kit-files.js";

export interface KitDocOptions {
  projectName: string;
  /** Source root the checks scan; the kit's default is `src`. */
  sourceRoot: string;
  /** Whether the source root exists when the docs are written. A Product Build
   *  project is materialized before any code, so its docs must not name a
   *  folder that is not there yet (its own doc-path check would fail). */
  sourceRootPresent: boolean;
  maxLoc: number;
  /** The project has a package.json the kit wired `npm run` scripts into. */
  npmScripts: boolean;
  /** TypeScript project: `code-refs` answers symbol questions. */
  typescript: boolean;
  /** Files an agent should open first, as `path — why` lines; ARCHITECTURE.md
   *  gets a "Read these first" section only when there are some. */
  readFirst?: string[];
  /** Appended as an "Environment" section: how the built app is served (the
   *  CSP for a static page, for instance). */
  environmentNotes?: string;
}

export function renderKitAgentsMd(o: KitDocOptions): string {
  const root = o.sourceRootPresent ? `\`${o.sourceRoot}/\`` : `${o.sourceRoot}/ (the source root; the first code creates it)`;
  // With a package.json the kit wired these as npm scripts; otherwise the
  // scripts are run directly.
  const direct: Record<string, string> = {
    "check:structure": "scripts/check-structure.mjs",
    "docs:map": "scripts/codebase-map.mjs",
    deps: "scripts/codebase-map.mjs --deps",
    refs: "scripts/code-refs.mjs",
  };
  const run = (script: string, args = "") => o.npmScripts
    ? `\`npm run ${script}${args ? ` -- ${args}` : ""}\``
    : `\`node ${direct[script]}${args ? ` ${args}` : ""}\``;
  const commands = [
    `| Structure check (runs before "done" is accepted) | ${run("check:structure")} |`,
    `| Regenerate the codebase map alone | ${run("docs:map")} |`,
    `| Who depends on a module, hop by hop, and the tests to run | ${run("deps", `${o.sourceRoot}/<module> --depth 2`)} |`,
    ...(o.typescript ? [`| Who uses a function, class, type or member (the compiler's answer) | ${run("refs", "<Name>")} (or \`<Class.member>\`, \`--duplicates\`) |`] : []),
  ];
  return `# AGENTS.md — rules for anyone changing this project

Read first: [ARCHITECTURE.md](ARCHITECTURE.md) (what owns what) and
[docs/codebase-map.md](docs/codebase-map.md) (generated: modules, importers,
dependencies, oversized files; written by the structure check). When a number
in prose disagrees with the map, the map wins.

## Commands

| Task | Command |
|---|---|
${commands.join("\n")}

## Layout

| Path | Holds | Rules |
|---|---|---|
| ${root} | the code, one capability per folder | a new folder is a module: give it a row in ARCHITECTURE.md before the check runs |
| \`scripts/\` | the structure checks | copied in when the project was created; change the project, not the checks |
| \`docs/codebase-map.md\` | generated facts | never hand-edit; the structure check regenerates it |
| \`docs/adr/\` | decisions and why | add one when you pick between real alternatives |
| \`docs/history/\` | finished plans and logs | read-only record; never cite as current |

## Code rules (the structure check enforces them)

- **No source file over ${o.maxLoc} lines.** Split by responsibility before it gets there. A generated file that must stay large is listed in \`.file-size-allow\` (one path per line); that list only shrinks.
- **Every module has an owner on record.** A folder under the source root needs a row in ARCHITECTURE.md naming it as \`${o.sourceRoot}/<module>/\` and saying what it owns and what it does not, or its own AGENTS.md.
- **Every path a doc names exists.** Move a file, fix the docs that name it.
- **One responsibility per file and per module.** A new capability gets its own module, not a corner of an existing one.
- **Extend the existing owner.** Before writing a new module, find the one that owns the concern in ARCHITECTURE.md.
- **Read before you edit.**
${o.environmentNotes ? `\n## Environment\n\n${o.environmentNotes.trim()}\n` : ""}
## When in doubt

Ask. Don't guess at product, money, security, or taste calls.
`;
}

export function renderKitArchitectureMd(o: KitDocOptions): string {
  const readFirst = o.readFirst?.length
    ? `## Read these first (in order)\n\n${o.readFirst.map((line, i) => `${i + 1}. ${line}`).join("\n")}\n\n`
    : "";
  return `# Architecture — ${o.projectName}

What owns what. Structural facts (importer counts, dependencies, oversized
files) are generated in [docs/codebase-map.md](docs/codebase-map.md); this doc
owns the meaning. Rules live in [AGENTS.md](AGENTS.md).

${readFirst}## Subsystem map

Every folder under the source root has a row here, naming it as
\`${o.sourceRoot}/<module>/\`; the structure check fails until it does. Say what a
module does NOT own when a neighbour is easy to confuse with it.

| Capability | Owner (canonical code) | Notes |
|---|---|---|
`;
}

export function renderAdr0001(date: string): string {
  return `# 0001. Record architecture decisions

**Status:** Accepted (${date}) · Supersedes: — · Superseded by: —

## Context

A decision that lives only in a chat transcript or one person's notes is
invisible to the next agent, who then relitigates it or quietly reverses it.

## Decision

Every decision between real alternatives gets a numbered file in this folder:
context, the decision in one paragraph, consequences, and what would make it
worth reopening. Numbers are never reused; a reversed decision gets a new ADR
that supersedes the old one, and only the old one's Status line changes.

## Consequences

Agents and people can read why the code is the way it is before changing it.
Writing one costs a few minutes at decision time.

## Revisit when

The folder is never read — then the entries are too long, or the index is
missing, not the practice.
`;
}

export function renderHistoryReadme(): string {
  return `# History

Finished plans, campaign logs, and design docs for shipped work. They describe
the code as it was. Paths here are not kept current and are not checked.
For the current design, start at [ARCHITECTURE.md](../../ARCHITECTURE.md).
`;
}

/** The one line a build prompt uses to point the model at the kit. */
export function structureKitPromptLine(): string {
  return `- The project carries AGENTS.md and ARCHITECTURE.md — read AGENTS.md first. Every folder you add under the source root needs its row in ARCHITECTURE.md, and no source file may pass 450 lines. \`${STRUCTURE_CHECK_COMMAND}\` runs when you report done and must pass; run it yourself before that.`;
}

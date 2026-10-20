/**
 * The guidance docs the structure kit writes into a project the agent builds:
 * rules (AGENTS.md), meaning (ARCHITECTURE.md), the first ADR and the history
 * folder's note. Filled in with the project's real commands and paths — a
 * placeholder left in a guidance doc is a stale claim on day one, and the
 * project's own doc-path check would fail on it.
 */
import { STRUCTURE_CHECK_COMMAND } from "./kit-files.js";
import { KIT_SIZE_CAPS } from "./kit-size.js";
import type { ProjectLanguage, SealTestRunner } from "./project-kind.js";

export interface KitDocOptions {
  projectName: string;
  /** Source roots the checks scan (repo-relative, forward slashes); the kit's
   *  default is `src`, Go projects have several. */
  sourceRoots: string[];
  /** Roots that do not exist when the docs are written. A Product Build
   *  project is materialized before any code, so its docs must not name a
   *  folder that is not there yet (its own doc-path check would fail). */
  absentRoots: string[];
  /** The size caps the kit's check holds the project to, in code lines. */
  sizeCaps: { file: number; fileWarn: number; fn: number; fnWarn: number };
  /** The project has a package.json the kit wired `npm run` scripts into. */
  npmScripts: boolean;
  /** TypeScript project: `code-refs` answers symbol questions. */
  typescript: boolean;
  language: ProjectLanguage;
  /** Which seal test shipped, or "compiler" when the language enforces the
   *  boundary itself and none did. */
  sealTest: SealTestRunner;
  /** Files an agent should open first, as `path — why` lines; ARCHITECTURE.md
   *  gets a "Read these first" section only when there are some. */
  readFirst?: string[];
  /** Appended as an "Environment" section: how the built app is served (the
   *  CSP for a static page, for instance). */
  environmentNotes?: string;
}

/** A root as a doc names it: a path only once it exists (the project's
 *  doc-path check holds the docs to that). */
const rootName = (o: KitDocOptions, root: string): string =>
  o.absentRoots.includes(root) ? `${root}/ (the first code creates it)` : `\`${root}/\``;

const SYMBOL_QUESTION = "Who uses a function, class, type or member";

function symbolCommandRow(o: KitDocOptions, run: (script: string, args?: string) => string): string[] {
  if (o.typescript) return [`| ${SYMBOL_QUESTION} (the compiler's answer) | ${run("refs", "<Name>")} (or \`<Class.member>\`, \`--duplicates\`) |`];
  if (o.language === "rust") return [`| ${SYMBOL_QUESTION} | rust-analyzer, or rename the item and \`cargo check\`: the compiler lists every use (\`refs\` is TypeScript-only) |`];
  if (o.language === "go") return [`| ${SYMBOL_QUESTION} | \`gopls references <file>:<line>:<col>\` (\`refs\` is TypeScript-only) |`];
  return [];
}

function moduleRule(o: KitDocOptions): string {
  const root = o.sourceRoots[0];
  const named = o.language === "go"
    ? `a package directory needs a row in ARCHITECTURE.md naming it as \`${root}/<package>/\``
    : o.language === "rust"
      ? `a module (a top-level folder or \`.rs\` file under \`src/\`) needs a row in ARCHITECTURE.md naming it as \`src/<module>/\` or \`src/<module>.rs\``
      : `a folder under the source root needs a row in ARCHITECTURE.md naming it as \`${root}/<module>/\``;
  return `- **Every module has an owner on record.** ${named.replace(/^a /, "A ")} and saying what it owns and what it does not, or its own AGENTS.md.`;
}

/** The size rule and why it exists: so the next reader (an agent) can find
 *  its way, which is also why comments never count against it. */
function sizeRule(o: KitDocOptions): string {
  const c = o.sizeCaps;
  return [
    `- **Size caps, in code lines: ${c.file} per file, ${c.fn} per function.** A line counts when it holds code; comment and blank lines are free. A function's count is its own: a function nested in it counts for itself. The check warns from ${c.fileWarn} (file) and ${c.fnWarn} (function) and lists those in \`docs/codebase-map.md\` under "Nearing the size cap".`,
    "  - Why: you and the next agent find your way by reading a whole file or function. Past the cap it is almost always doing a second job.",
    "  - Near or over the cap: find the job that grew and move it into a module (or function) named after that job. Never delete comments to fit (they don't count), and never name the split, the file or the commit after the limit (\"part 2\", \"under the 400-line cap\").",
    "  - `.code-size-ratchet` (absent in a new project) lists anything that was over a cap, at its recorded size; it may only shrink.",
  ].join("\n");
}

function boundaryRule(o: KitDocOptions): string[] {
  switch (o.sealTest) {
    case "vitest":
      return [`- **Module boundaries are tested.** \`${o.sourceRoots[0]}/module-seals.test.ts\` holds the seal table (import a module only through its entry) and the forbidden-dependency table; add a row when a module gains outside importers, and export a missing symbol from the entry rather than loosen a seal.`];
    case "pytest":
      return ["- **Module boundaries are tested.** `tests/test_module_seals.py` holds the seal table (import a package only through its public modules) and the forbidden-dependency table; add a row when a package gains outside importers."];
    case "compiler":
      return o.language === "go"
        ? ["- **Module boundaries are the compiler's.** A package under `internal/` cannot be imported from outside this module and an unexported name stays in its package, so there is no seal test: `go build` is one. Keep a name unexported until another package needs it."]
        : ["- **Module boundaries are the compiler's.** An item is private to its module unless marked `pub` (`pub(crate)` for the crate alone), so there is no seal test: `rustc` is one. Keep an item private until another module needs it."];
    default:
      return [];
  }
}

export function renderKitAgentsMd(o: KitDocOptions): string {
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
    `| Who depends on a module, hop by hop, and the tests to run | ${run("deps", `${o.sourceRoots[0]}/<module> --depth 2`)} |`,
    ...symbolCommandRow(o, run),
  ];
  const unit = o.language === "go" ? "package" : "capability";
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
| ${o.sourceRoots.map((r) => rootName(o, r)).join(", ")} | the code, one ${unit} per folder | a new folder is a module: give it a row in ARCHITECTURE.md before the check runs |
| \`scripts/\` | the structure checks | copied in when the project was created; change the project, not the checks |
| \`docs/codebase-map.md\` | generated facts | never hand-edit; the structure check regenerates it |
| \`docs/adr/\` | decisions and why | add one when you pick between real alternatives |
| \`docs/history/\` | finished plans and logs | read-only record; never cite as current |

## Code rules (the structure check enforces them)

${sizeRule(o)}
${moduleRule(o)}
- **Every path a doc names exists.** Move a file, fix the docs that name it.
- **One responsibility per file and per module.** A new capability gets its own module, not a corner of an existing one.
- **Extend the existing owner.** Before writing a new module, find the one that owns the concern in ARCHITECTURE.md.
${boundaryRule(o).map((l) => `${l}\n`).join("")}- **Read before you edit.**
${o.environmentNotes ? `\n## Environment\n\n${o.environmentNotes.trim()}\n` : ""}
## When in doubt

Ask. Don't guess at product, money, security, or taste calls.
`;
}

export function renderKitArchitectureMd(o: KitDocOptions): string {
  const readFirst = o.readFirst?.length
    ? `## Read these first (in order)\n\n${o.readFirst.map((line, i) => `${i + 1}. ${line}`).join("\n")}\n\n`
    : "";
  const roots = o.sourceRoots.map((r) => rootName(o, r)).join(", ");
  const example = o.language === "go" ? `\`${o.sourceRoots[0]}/<package>/\``
    : o.language === "rust" ? "`src/<module>/` or `src/<module>.rs`"
      : `\`${o.sourceRoots[0]}/<module>/\``;
  return `# Architecture — ${o.projectName}

What owns what. Structural facts (importer counts, dependencies, oversized
files) are generated in [docs/codebase-map.md](docs/codebase-map.md); this doc
owns the meaning. Rules live in [AGENTS.md](AGENTS.md).

${readFirst}## Subsystem map

Every module under the source root (${roots}) has a row here, naming it as
${example}; the structure check fails until it does. Say what a
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
  return `- The project carries AGENTS.md and ARCHITECTURE.md — read AGENTS.md first. Every folder you add under the source root needs its row in ARCHITECTURE.md, and no file may pass ${KIT_SIZE_CAPS.file} code lines nor a function ${KIT_SIZE_CAPS.fn} (comments are free; near the cap, move the job that grew into a module named after it). \`${STRUCTURE_CHECK_COMMAND}\` runs when you report done and must pass; run it yourself before that.`;
}

/** The same promise for a project the model scaffolds itself (a framework
 *  creator the harness does not run): the kit arrives at the first done
 *  report, so the line cannot claim the files are already there. */
export function structureKitAdoptionPromptLine(): string {
  return `- When you first report done, the harness adds the structure kit to the project (AGENTS.md, ARCHITECTURE.md with an owner table, \`${STRUCTURE_CHECK_COMMAND}\`) and runs that check: every folder under the source root needs a row in ARCHITECTURE.md saying what it owns, and no file may pass ${KIT_SIZE_CAPS.file} code lines nor a function ${KIT_SIZE_CAPS.fn} (comments are free). If the check fails, fix what it lists and report done again.`;
}

/**
 * The structure kit a project the agent builds starts with: AGENTS.md,
 * ARCHITECTURE.md (the owner table), ADR 0001, docs/history, the check scripts
 * and one command that runs them (`node scripts/check-structure.mjs`). The
 * project owns its checks from then on; nothing here is needed to keep it
 * healthy.
 *
 * Applied where a project is created — the Vite scaffold, Product Build's
 * materialization, build_app's other real tiers — or adopted at the first
 * done-claim of a new build whose project the model scaffolded itself
 * (`adoptProjectKit`), and never to an existing tree beyond that: every file
 * that exists is left alone, so a later retrofit is the same call, made on
 * request. What the kit writes follows the project kind on disk
 * (project-kind.ts): the roots its checks scan, and the seal test its test
 * runner runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  KIT_SCRIPTS, KIT_SEAL_TEST, KIT_SIZE_CAPS, KIT_SEAL_TEST_PY, STRUCTURE_CHECK_COMMAND, STRUCTURE_CHECK_SCRIPT, readKitFile,
} from "./kit-files.js";
import { recordCreatorDocs } from "./creator-docs.js";
import { detectProjectKind, hasDependency, hasProjectFile } from "./project-kind.js";
import { renderAdr0001, renderHistoryReadme, renderKitAgentsMd, renderKitArchitectureMd, type KitDocOptions } from "./render-docs.js";

export { KIT_SIZE_CAPS, STRUCTURE_CHECK_COMMAND, STRUCTURE_CHECK_SCRIPT } from "./kit-files.js";
export { structureKitAdoptionPromptLine, structureKitPromptLine } from "./render-docs.js";
export { structureWarningNote } from "./structure-check-output.js";

export interface ProjectKitOptions {
  projectName: string;
  /** Overrides the root the project kind implies (project-kind.ts). */
  sourceRoot?: string;
  /** See KitDocOptions.readFirst. */
  readFirst?: string[];
  /** See KitDocOptions.environmentNotes. */
  environmentNotes?: string;
}

export interface KitFile {
  /** Project-relative, forward slashes. */
  rel: string;
  content: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(projectDir: string): PackageJson | null {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJson;
  } catch {
    return null; // not JSON: the kit leaves it alone and writes no npm scripts
  }
}

/** The pytest template assumes tests/ beside src/; its one root constant is
 *  rewritten for any other root. */
function pytestSealTest(root: string): string {
  return readKitFile(KIT_SEAL_TEST_PY).replace('SOURCE_ROOT = "../src"', `SOURCE_ROOT = "../${root}"`);
}

/**
 * The kit's files for a project, before any is written. Pure apart from reading
 * the vendored scripts and the project's own files, so a staged writer (Product
 * Build's materializer) can queue them with its own artifacts.
 */
export function projectKitFiles(
  projectDir: string,
  opts: ProjectKitOptions,
  now: Date = new Date(),
): KitFile[] {
  const kind = detectProjectKind(projectDir);
  const sourceRoots = opts.sourceRoot ? [opts.sourceRoot] : kind.sourceRoots;
  const docs: KitDocOptions = {
    projectName: opts.projectName,
    sourceRoots,
    absentRoots: sourceRoots.filter((r) => !existsSync(join(projectDir, r))),
    sizeCaps: KIT_SIZE_CAPS,
    npmScripts: readPackageJson(projectDir) !== null,
    typescript: kind.typescript,
    language: kind.language,
    sealTest: kind.sealTest,
    readFirst: opts.readFirst,
    environmentNotes: opts.environmentNotes,
  };
  const files: KitFile[] = [
    { rel: "AGENTS.md", content: renderKitAgentsMd(docs) },
    { rel: "ARCHITECTURE.md", content: renderKitArchitectureMd(docs) },
    { rel: "docs/adr/0001-record-architecture-decisions.md", content: renderAdr0001(now.toISOString().slice(0, 10)) },
    { rel: "docs/history/README.md", content: renderHistoryReadme() },
    ...KIT_SCRIPTS.map((name) => ({ rel: `scripts/${name}`, content: readKitFile(name) })),
  ];
  // The seal test needs a runner; without one it would be a file nothing runs.
  // Rust and Go ship none: the compiler enforces the boundary.
  if (kind.sealTest === "vitest") {
    files.push({ rel: `${sourceRoots[0]}/module-seals.test.ts`, content: readKitFile(KIT_SEAL_TEST) });
  } else if (kind.sealTest === "pytest") {
    files.push({ rel: "tests/test_module_seals.py", content: pytestSealTest(sourceRoots[0]) });
  }
  return files;
}

export interface ApplyKitResult {
  written: string[];
  /** Files left as they were because they already existed. */
  skipped: string[];
  /** package.json gained the kit's scripts (and `build` runs the check first). */
  wiredNpmScripts: boolean;
  /** Docs that came with the project (a framework creator's README), recorded
   *  so the doc-path check skips them until they are edited (creator-docs.ts). */
  creatorDocs: string[];
}

/**
 * Write the kit into an existing project directory and, when it has a
 * package.json, wire `check:structure` / `docs:map` / `deps` (/ `refs`, and
 * `test` for the seal test) and put the check in front of `build`. Idempotent:
 * existing files and existing scripts are never overwritten. On the kit's
 * first landing the docs already there are recorded as the creator's: every
 * caller applies it where a project was just created. The one soft spot is
 * adoption at a new build's first done-claim, where the model may already
 * have edited a creator's README; that README is checked once it changes.
 */
export function applyProjectKit(projectDir: string, opts: ProjectKitOptions): ApplyKitResult {
  const firstLanding = structureCheckCommand(projectDir) === null;
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of projectKitFiles(projectDir, opts)) {
    const abs = join(projectDir, file.rel);
    if (existsSync(abs)) { skipped.push(file.rel); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf-8");
    written.push(file.rel);
  }
  const creatorDocs = firstLanding ? recordCreatorDocs(projectDir, new Set(written)) : [];
  return { written, skipped, wiredNpmScripts: wireNpmScripts(projectDir), creatorDocs };
}

/**
 * The kit for a project someone else created: a framework creator the model
 * ran (Next, Nuxt, SvelteKit, Astro, React Router need an empty directory, so the
 * kit cannot go in first). Applied when the directory holds a project file
 * and no kit yet; null when there is nothing to adopt, so a caller can tell
 * "applied" from "nothing to do". The caller decides that this is a NEW
 * build: an existing app is never retrofitted uninvited.
 */
export function adoptProjectKit(projectDir: string, opts: ProjectKitOptions): ApplyKitResult | null {
  if (structureCheckCommand(projectDir) !== null || !hasProjectFile(projectDir)) return null;
  return applyProjectKit(projectDir, opts);
}

/** The kit's npm scripts, added only where absent; `build` runs the structure
 *  check first unless it already does. Returns whether anything changed. */
function wireNpmScripts(projectDir: string): boolean {
  const pkg = readPackageJson(projectDir);
  if (!pkg) return false;
  const scripts = pkg.scripts ?? {};
  const wanted: Record<string, string> = {
    "check:structure": STRUCTURE_CHECK_COMMAND,
    "docs:map": "node scripts/codebase-map.mjs",
    deps: "node scripts/codebase-map.mjs --deps",
    ...(hasDependency(pkg, "typescript") ? { refs: "node scripts/code-refs.mjs" } : {}),
    ...(hasDependency(pkg, "vitest") ? { test: "vitest run" } : {}),
  };
  let changed = false;
  for (const [name, command] of Object.entries(wanted)) {
    if (scripts[name] !== undefined) continue;
    scripts[name] = command;
    changed = true;
  }
  if (!scripts.build?.includes("check:structure")) {
    scripts.build = scripts.build ? `npm run check:structure && ${scripts.build}` : "npm run check:structure";
    changed = true;
  }
  if (!changed) return false;
  pkg.scripts = scripts;
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  return true;
}

/** The command a harness gate runs for a project that carries the kit, or null
 *  for a project that does not (one without the kit is never held to it). */
export function structureCheckCommand(projectDir: string): string | null {
  return existsSync(join(projectDir, STRUCTURE_CHECK_SCRIPT)) ? STRUCTURE_CHECK_COMMAND : null;
}

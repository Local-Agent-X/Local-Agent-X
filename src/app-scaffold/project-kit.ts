/**
 * The structure kit a project the agent builds starts with: AGENTS.md,
 * ARCHITECTURE.md (the owner table), ADR 0001, docs/history, the check scripts
 * and one command that runs them (`node scripts/check-structure.mjs`). The
 * project owns its checks from then on; nothing here is needed to keep it
 * healthy.
 *
 * Applied where a project is created — the Vite scaffold, Product Build's
 * materialization, build_app's other real tiers — and never to an existing
 * tree: every file that exists is left alone, so a later retrofit is the same
 * call, made on request.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  KIT_SCRIPTS, KIT_SEAL_TEST, STRUCTURE_CHECK_COMMAND, STRUCTURE_CHECK_SCRIPT, readKitFile,
} from "./kit-files.js";
import { renderAdr0001, renderHistoryReadme, renderKitAgentsMd, renderKitArchitectureMd, type KitDocOptions } from "./render-docs.js";

export { STRUCTURE_CHECK_COMMAND, STRUCTURE_CHECK_SCRIPT } from "./kit-files.js";
export { structureKitPromptLine } from "./render-docs.js";

/** The kit's file-size ceiling: the /new-project default for new projects. */
export const KIT_MAX_LOC = 450;
const DEFAULT_SOURCE_ROOT = "src";

export interface ProjectKitOptions {
  projectName: string;
  /** Default `src`. */
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

const hasDependency = (pkg: PackageJson | null, name: string): boolean =>
  !!(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);

/**
 * The kit's files for a project, before any is written. Pure apart from reading
 * the vendored scripts, so a staged writer (Product Build's materializer) can
 * queue them with its own artifacts.
 */
export function projectKitFiles(
  projectDir: string,
  opts: ProjectKitOptions,
  now: Date = new Date(),
): KitFile[] {
  const sourceRoot = opts.sourceRoot ?? DEFAULT_SOURCE_ROOT;
  const pkg = readPackageJson(projectDir);
  const docs: KitDocOptions = {
    projectName: opts.projectName,
    sourceRoot,
    sourceRootPresent: existsSync(join(projectDir, sourceRoot)),
    maxLoc: KIT_MAX_LOC,
    npmScripts: pkg !== null,
    typescript: hasDependency(pkg, "typescript"),
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
  // The seal test needs a runner; without vitest it would be a file nothing runs.
  if (hasDependency(pkg, "vitest")) {
    files.push({ rel: `${sourceRoot}/module-seals.test.ts`, content: readKitFile(KIT_SEAL_TEST) });
  }
  return files;
}

export interface ApplyKitResult {
  written: string[];
  /** Files left as they were because they already existed. */
  skipped: string[];
  /** package.json gained the kit's scripts (and `build` runs the check first). */
  wiredNpmScripts: boolean;
}

/**
 * Write the kit into an existing project directory and, when it has a
 * package.json, wire `check:structure` / `docs:map` / `deps` (/ `refs`) and put
 * the check in front of `build`. Idempotent: existing files and existing
 * scripts are never overwritten.
 */
export function applyProjectKit(projectDir: string, opts: ProjectKitOptions): ApplyKitResult {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of projectKitFiles(projectDir, opts)) {
    const abs = join(projectDir, file.rel);
    if (existsSync(abs)) { skipped.push(file.rel); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf-8");
    written.push(file.rel);
  }
  return { written, skipped, wiredNpmScripts: wireNpmScripts(projectDir) };
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

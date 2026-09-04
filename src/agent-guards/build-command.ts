// Build-command detection for the orchestrator build-verify gate.
//
// Given the source files an op edited, find the project to verify and the
// command that verifies it — by reading the project's OWN manifests, never
// by hard-coding a language or path. The orchestrator runs the result itself
// (see canonical-loop/turn-loop/build-verify.ts) when the model edits source
// and wraps up without a clean self-verify.
//
// Pure over an injected FsProbe so it's testable without disk: production
// passes a node:fs-backed probe, tests pass a fake tree. All input paths are
// assumed absolute (build-verify resolves them before calling in).

import { dirname, relative } from "node:path";

/** Minimal filesystem surface the detector needs. */
export interface FsProbe {
  /** True if a file or directory exists at the absolute path. */
  exists(path: string): boolean;
  /** Parsed JSON at the path, or null if missing / unreadable / invalid. */
  readJson(path: string): unknown;
}

export interface BuildCommand {
  /** Shell command to run, as the project itself declares it where possible. */
  command: string;
  /** Absolute directory to run it in (the project root nearest the edits). */
  cwd: string;
  /** What kind of check this is — typecheck is preferred (fast, side-effect
   *  free, catches the broken-reference class); build/check are fallbacks. */
  kind: "typecheck" | "build" | "check";
}

// Manifests that mark a directory as a buildable project root. Order matters
// only for the per-file walk-up tie-break (first match wins as we ascend).
const MANIFESTS = ["package.json", "tsconfig.json", "Cargo.toml", "go.mod"];

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

// Path comparisons fold case ONLY where the filesystem itself does. Folding
// everywhere would make `/home/me/Workspace/Apps/web` compare equal to
// `…/workspace/apps/web` on a case-SENSITIVE filesystem, where those are two
// different directories — a false app match there disables a real project's
// verification (see workspaceAppDir).
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** The comparison spelling of a path: forward slashes, case-folded only on a
 *  case-insensitive filesystem. Exported as the ONE spelling this guard and
 *  verify-gate.ts compare paths/commands in — NOT as a character-index basis:
 *  toLowerCase() is not 1:1 per character (see findWorkspaceApp). */
export function normPath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  return CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
}

interface WorkspaceApp {
  /** The `<slug>` segment, in comparison spelling. */
  slug: string;
  /** `…/workspace/apps/<slug>`, in the path's OWN spelling. */
  dir: string;
  /** The `…/workspace` prefix of `dir`, in the path's OWN spelling. */
  workspaceDir: string;
}

// The agent's own app projects live at `<workspace>/apps/<slug>`. ONE parser for
// that shape, shared with verify-gate.ts's verifyTargetsEditedApp.
//
// Matched by SEGMENT, never by indexing the original string with an offset taken
// from its normalized spelling. Invariant that buys: `dir` and `workspaceDir`
// are always real prefixes of `filePath`. A match offset would NOT give that —
// normPath's case-fold is not 1:1 per character ("İ".toLowerCase() is two chars),
// so on a path holding one the offset drifts and the "app dir" comes back
// truncated: it then never equals any ancestor, the ceiling below never fires,
// and the walk-up escapes into the workspace root's own project — the exact
// incident the ceiling exists to prevent.
function findWorkspaceApp(filePath: string): WorkspaceApp | null {
  const values: string[] = [];
  const ends: number[] = [];
  let start = 0;
  for (let i = 0; i <= filePath.length; i++) {
    const c = filePath[i];
    if (i === filePath.length || c === "/" || c === "\\") {
      values.push(normPath(filePath.slice(start, i)));
      ends.push(i);
      start = i + 1;
    }
  }
  for (let i = 0; i + 2 < values.length; i++) {
    if (values[i] === "workspace" && values[i + 1] === "apps" && values[i + 2] !== "") {
      return {
        slug: values[i + 2],
        dir: filePath.slice(0, ends[i + 2]),
        workspaceDir: filePath.slice(0, ends[i]),
      };
    }
  }
  return null;
}

/** The slug of the `workspace/apps/<slug>` app a path belongs to, or null. */
export function workspaceAppSlug(filePath: string): string | null {
  return findWorkspaceApp(filePath)?.slug ?? null;
}

/**
 * The `…/workspace/apps/<slug>` directory a path lives under — in the path's OWN
 * spelling — or null when it isn't inside a workspace app.
 *
 * `workspaceRoot` ANCHORS the shape to the agent's REAL workspace: only
 * `<workspaceRoot>/apps/<slug>` counts. Unanchored, this is a path-SHAPE guess,
 * and `workspace/apps/<name>` is also the ordinary Turborepo/Nx layout under a
 * personal `~/workspace` — calling a user's own monorepo an agent app puts a
 * ceiling BELOW its manifest and the project silently stops being verified at
 * all. Omitting the root yields NO ceiling (the pre-ceiling behavior) rather
 * than a guess: the caller that knows the workspace passes it.
 */
export function workspaceAppDir(filePath: string, workspaceRoot?: string): string | null {
  const found = findWorkspaceApp(filePath);
  if (!found) return null;
  if (workspaceRoot !== undefined && !sameDir(found.workspaceDir, workspaceRoot)) return null;
  return found.dir;
}

function sameDir(a: string, b: string): boolean {
  return normPath(a).replace(/\/+$/, "") === normPath(b).replace(/\/+$/, "");
}

/** Walk up from a file's directory to the nearest ancestor holding any build
 *  manifest. Returns null if none up to the filesystem root.
 *
 *  A file inside a workspace app stops at that app's own directory: above it is
 *  the WORKSPACE root, which holds LAX's own package.json and tsconfig.json. An
 *  unconfined walk-up out of an app with no manifest of its own (a static HTML
 *  clone, a plain-JS app) therefore anchored on LAX's TypeScript project and the
 *  gate type-checked src/ari-kernel/*.ts, telling the agent its edits had broken
 *  a project it never opened. An app that declares no verifiable project has
 *  nothing to verify — that's a no-op (null), never someone else's build.
 *
 *  The ceiling exists ONLY when the caller supplies the agent's real workspace
 *  root — see workspaceAppDir. With no root there is no ceiling and the walk-up
 *  is unconfined, exactly as it was before the ceiling existed. */
function nearestProjectDir(filePath: string, fs: FsProbe, workspaceRoot?: string): string | null {
  const appDir = workspaceRoot === undefined ? null : workspaceAppDir(filePath, workspaceRoot);
  let dir = dirname(filePath);
  // dirname("/") === "/" — stop when we stop ascending.
  for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    for (const m of MANIFESTS) {
      if (fs.exists(joinPath(dir, m))) return dir;
    }
    if (appDir && sameDir(dir, appDir)) return null; // never escape the edited app
  }
  return null;
}

/** Pick the package manager from a lockfile in the project dir; default npm. */
function packageManager(dir: string, fs: FsProbe): string {
  if (fs.exists(joinPath(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.exists(joinPath(dir, "yarn.lock"))) return "yarn";
  if (fs.exists(joinPath(dir, "bun.lockb"))) return "bun";
  return "npm";
}

function hasScript(pkg: unknown, name: string): boolean {
  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts;
  return typeof scripts?.[name] === "string";
}

/**
 * A "solution" tsconfig delegates all compilation to referenced projects and
 * lists no files of its own — the standard Vite/CRA-TS layout, where the root
 * `tsconfig.json` is `{ "files": [], "references": [tsconfig.app.json, …] }`.
 * `tsc --noEmit` against it compiles ZERO files, so the type-check silently
 * passes a broken app (a real Vite build reported 7 errors that this gate had
 * green-lit). Build mode (`tsc -b`) follows the references and checks the real
 * projects. Detect the layout so the gate picks the right mode.
 */
function isSolutionTsconfig(cfg: unknown): boolean {
  const c = cfg as { references?: unknown; files?: unknown; include?: unknown } | null;
  if (!c || !Array.isArray(c.references) || c.references.length === 0) return false;
  const noOwnFiles = !Array.isArray(c.files) || c.files.length === 0;
  const noInclude = !Array.isArray(c.include) || c.include.length === 0;
  return noOwnFiles && noInclude;
}

/** The tsc type-check command for a dir holding a tsconfig — build mode for a
 *  references-only solution config (else `--noEmit` is a no-op), plain
 *  `--noEmit` otherwise. Prefers the locally-installed binary (no network). */
function tscCheckCommand(dir: string, fs: FsProbe): BuildCommand {
  const localTsc = joinPath(dir, "node_modules/.bin/tsc");
  const tsc = fs.exists(localTsc) ? "node_modules/.bin/tsc" : "npx --no-install tsc";
  const flag = isSolutionTsconfig(fs.readJson(joinPath(dir, "tsconfig.json"))) ? "-b" : "--noEmit";
  return { command: `${tsc} ${flag}`, cwd: dir, kind: "typecheck" };
}

/** Resolve the verify command for a single project directory. Prefers the
 *  project's declared typecheck script, then a synthesized `tsc --noEmit`,
 *  then a declared build script, then language defaults. */
function commandForDir(dir: string, fs: FsProbe): BuildCommand | null {
  const hasPkg = fs.exists(joinPath(dir, "package.json"));
  const hasTsconfig = fs.exists(joinPath(dir, "tsconfig.json"));

  if (hasPkg) {
    const pkg = fs.readJson(joinPath(dir, "package.json"));
    const pm = packageManager(dir, fs);
    // A project's own typecheck script encodes its correct invocation — prefer
    // it over anything we synthesize. type-check is the common hyphenated alias.
    if (hasScript(pkg, "typecheck")) return { command: `${pm} run typecheck`, cwd: dir, kind: "typecheck" };
    if (hasScript(pkg, "type-check")) return { command: `${pm} run type-check`, cwd: dir, kind: "typecheck" };
    // No typecheck script but a tsconfig: run the compiler in check-only mode
    // (build mode for a references-only solution config — see tscCheckCommand).
    if (hasTsconfig) return tscCheckCommand(dir, fs);
    // Last resort for a Node project: its build script (may bundle / be slow,
    // hence below the type-check options).
    if (hasScript(pkg, "build")) return { command: `${pm} run build`, cwd: dir, kind: "build" };
    return null;
  }

  // A bare tsconfig with no package.json — still type-checkable.
  if (hasTsconfig) return tscCheckCommand(dir, fs);

  if (fs.exists(joinPath(dir, "Cargo.toml"))) return { command: "cargo check", cwd: dir, kind: "check" };
  if (fs.exists(joinPath(dir, "go.mod"))) return { command: "go build ./...", cwd: dir, kind: "check" };

  return null;
}

/**
 * Detect the single build/type-check command to verify an op's edits. When
 * edits span multiple projects, the one with the most edited files wins (the
 * primary edit target); ties resolve to the first encountered. Returns null
 * when no buildable project is found — the caller must then NOT fabricate a
 * verification, only report it couldn't run one.
 *
 * `workspaceRoot` (the agent's real workspace dir) confines the walk-up inside
 * an agent app; omitted, the walk-up is unconfined. Passed IN rather than read
 * here so this module stays pure — no I/O, no config.
 */
export function detectBuildCommand(editedPaths: string[], fs: FsProbe, workspaceRoot?: string): BuildCommand | null {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const p of editedPaths) {
    const dir = nearestProjectDir(p, fs, workspaceRoot);
    if (!dir) continue;
    if (!counts.has(dir)) order.push(dir);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  if (order.length === 0) return null;

  let bestDir = order[0];
  for (const dir of order) {
    if ((counts.get(dir) ?? 0) > (counts.get(bestDir) ?? 0)) bestDir = dir;
  }
  return commandForDir(bestDir, fs);
}

/** A command to run specific test files (targeted — not the whole suite). */
export interface TestCommand {
  command: string;
  cwd: string;
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/** True for a unit/integration test file (`*.test.ts`, `*.spec.tsx`, …). */
export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/**
 * When an op edited test files, detect a command to run THOSE specific tests
 * (targeted, so a self-inconsistent test change is caught cheaply — not the whole
 * suite). Prefers the locally-installed vitest/jest binary; returns null when no
 * test file was edited or no runner is found (the caller then just skips the test
 * pass — never fabricates a verdict). Complements detectBuildCommand: the gate
 * type-checks first, then runs edited tests, because a type-clean edit whose own
 * test is red is not done.
 *
 * `workspaceRoot` carries the SAME meaning as in detectBuildCommand — both share
 * nearestProjectDir, so both must be anchored the same way or the two halves of
 * one gate would disagree about where a project ends.
 */
export function detectTestCommand(editedPaths: string[], fs: FsProbe, workspaceRoot?: string): TestCommand | null {
  const testFiles = editedPaths.filter(isTestFile);
  if (testFiles.length === 0) return null;

  // Group by project dir; the project with the most edited test files wins
  // (mirrors detectBuildCommand's primary-target tie-break).
  const byDir = new Map<string, string[]>();
  const order: string[] = [];
  for (const p of testFiles) {
    const dir = nearestProjectDir(p, fs, workspaceRoot);
    if (!dir) continue;
    if (!byDir.has(dir)) { byDir.set(dir, []); order.push(dir); }
    byDir.get(dir)!.push(p);
  }
  if (order.length === 0) return null;
  let bestDir = order[0];
  for (const dir of order) {
    if ((byDir.get(dir)?.length ?? 0) > (byDir.get(bestDir)?.length ?? 0)) bestDir = dir;
  }

  // Forward slashes regardless of host OS: vitest/jest accept them on Windows,
  // and a backslash path would be escape-mangled if this command runs through a
  // POSIX-ish shell (Git Bash). relative() emits `\` on win32.
  const rels = byDir.get(bestDir)!.map((f) => relative(bestDir, f).replaceAll("\\", "/"));
  const vitest = joinPath(bestDir, "node_modules/.bin/vitest");
  if (fs.exists(vitest)) return { command: `node_modules/.bin/vitest run ${rels.join(" ")}`, cwd: bestDir };
  const jest = joinPath(bestDir, "node_modules/.bin/jest");
  if (fs.exists(jest)) return { command: `node_modules/.bin/jest ${rels.join(" ")}`, cwd: bestDir };
  return null;
}

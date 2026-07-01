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

/** Walk up from a file's directory to the nearest ancestor holding any build
 *  manifest. Returns null if none up to the filesystem root. */
function nearestProjectDir(filePath: string, fs: FsProbe): string | null {
  let dir = dirname(filePath);
  // dirname("/") === "/" — stop when we stop ascending.
  for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    for (const m of MANIFESTS) {
      if (fs.exists(joinPath(dir, m))) return dir;
    }
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
    // No typecheck script but a tsconfig: run the compiler in check-only mode.
    // Prefer the locally-installed binary (no network), else npx without an
    // implicit install so a missing tsc fails fast instead of downloading.
    if (hasTsconfig) {
      const localTsc = joinPath(dir, "node_modules/.bin/tsc");
      const tsc = fs.exists(localTsc) ? "node_modules/.bin/tsc" : "npx --no-install tsc";
      return { command: `${tsc} --noEmit`, cwd: dir, kind: "typecheck" };
    }
    // Last resort for a Node project: its build script (may bundle / be slow,
    // hence below the type-check options).
    if (hasScript(pkg, "build")) return { command: `${pm} run build`, cwd: dir, kind: "build" };
    return null;
  }

  // A bare tsconfig with no package.json — still type-checkable.
  if (hasTsconfig) {
    const localTsc = joinPath(dir, "node_modules/.bin/tsc");
    const tsc = fs.exists(localTsc) ? "node_modules/.bin/tsc" : "npx --no-install tsc";
    return { command: `${tsc} --noEmit`, cwd: dir, kind: "typecheck" };
  }

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
 */
export function detectBuildCommand(editedPaths: string[], fs: FsProbe): BuildCommand | null {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const p of editedPaths) {
    const dir = nearestProjectDir(p, fs);
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
 */
export function detectTestCommand(editedPaths: string[], fs: FsProbe): TestCommand | null {
  const testFiles = editedPaths.filter(isTestFile);
  if (testFiles.length === 0) return null;

  // Group by project dir; the project with the most edited test files wins
  // (mirrors detectBuildCommand's primary-target tie-break).
  const byDir = new Map<string, string[]>();
  const order: string[] = [];
  for (const p of testFiles) {
    const dir = nearestProjectDir(p, fs);
    if (!dir) continue;
    if (!byDir.has(dir)) { byDir.set(dir, []); order.push(dir); }
    byDir.get(dir)!.push(p);
  }
  if (order.length === 0) return null;
  let bestDir = order[0];
  for (const dir of order) {
    if ((byDir.get(dir)?.length ?? 0) > (byDir.get(bestDir)?.length ?? 0)) bestDir = dir;
  }

  const rels = byDir.get(bestDir)!.map((f) => relative(bestDir, f));
  const vitest = joinPath(bestDir, "node_modules/.bin/vitest");
  if (fs.exists(vitest)) return { command: `node_modules/.bin/vitest run ${rels.join(" ")}`, cwd: bestDir };
  const jest = joinPath(bestDir, "node_modules/.bin/jest");
  if (fs.exists(jest)) return { command: `node_modules/.bin/jest ${rels.join(" ")}`, cwd: bestDir };
  return null;
}

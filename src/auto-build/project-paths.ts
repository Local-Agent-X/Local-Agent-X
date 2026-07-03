/**
 * Resolve project_dir args from run_build_plan, build_plan_resume,
 * build_plan_status, finalize_app_build.
 *
 * Three input shapes are accepted:
 *   1. Absolute path  → use as-is (e.g. "C:/Users/alice/some-project")
 *   2. Bare name      → resolve to <workspace-root>/apps/<name> (e.g. "petbook")
 *   3. Relative path  → resolved against process.cwd() (legacy behavior)
 *
 * Why bare names default to the workspace root's apps/: that's LAX's convention
 * for project directories — per-machine, gitignored, the SAME place `build_app`
 * outputs into. It MUST resolve through config's workspaceRoot() (→ ~/Documents/
 * Local Agent X/workspace in the packaged app), NOT the code location: deriving
 * it from import.meta.url put builds at <repo>/workspace/apps, which the
 * file-access sandbox protects as source — so every field-agent write was
 * blocked ("writes only allowed to <Documents>/workspace"). workspaceRoot() is
 * the one writable, served location and keeps this in lockstep with build_app.
 *
 * An absolute path still wins — power users with projects outside the
 * workspace pass the full path explicitly.
 */

import { isAbsolute, join, resolve } from "node:path";
import { workspaceRoot } from "../config.js";
import { realpathDeep } from "../workspace/paths.js";

/** Canonical projects directory: <workspace-root>/apps (NOT the code location). */
export function projectsDir(): string {
  return join(workspaceRoot(), "apps");
}

/**
 * Resolve a project_dir arg. Returns null on empty/invalid input so the
 * caller can return a clean "argument missing" error.
 */
export function resolveProjectDir(raw: unknown): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  // On Windows, node:path treats "/tmp/x" as absolute on the current drive and
  // realpathDeep can turn it into "C:\tmp\x". For this resolver, a leading
  // slash is a POSIX absolute path supplied by the caller, not a request to
  // reinterpret it on the host drive. Preserve it exactly.
  if (process.platform === "win32" && /^\/(?!\/)/.test(s)) return s;
  // isAbsolute() is platform-specific — on POSIX it doesn't recognize a
  // Windows drive path like "C:\proj". Accept both so a path absolute on its
  // origin OS passes through unchanged regardless of where this runs.
  //
  // realpathDeep at the END: this is the establishment chokepoint for every
  // auto-build entry (run_build_plan / status / resume / finalize), so the
  // projectDir every downstream consumer sees — orchestrator state, git ops,
  // work-root registration, chunk task text — carries the junction-TARGET
  // spelling. Without it, a workspace junction hands one physical project to
  // different subsystems under two spellings, and anything keying or comparing
  // the raw string splits it in two (three live failures: security gate,
  // work-root anchor, stale-read guard). Nonexistent dirs pass through
  // realpathDeep unchanged (deepest-existing-ancestor rule), so the callers'
  // existsSync checks still fire on the same path they report.
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) return realpathDeep(s);
  if (isBareName(s)) return realpathDeep(join(projectsDir(), s));
  return realpathDeep(resolve(process.cwd(), s));
}

function isBareName(s: string): boolean {
  return !s.includes("/") && !s.includes("\\");
}

/**
 * Resolve project_dir args from primal_run_build_plan, primal_build_resume,
 * primal_build_status, finalize_app_build.
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
  // isAbsolute() is platform-specific — on POSIX it doesn't recognize a
  // Windows drive path like "C:\proj". Accept both so a path absolute on its
  // origin OS passes through unchanged regardless of where this runs.
  if (isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s)) return s;
  if (isBareName(s)) return join(projectsDir(), s);
  return resolve(process.cwd(), s);
}

function isBareName(s: string): boolean {
  return !s.includes("/") && !s.includes("\\");
}

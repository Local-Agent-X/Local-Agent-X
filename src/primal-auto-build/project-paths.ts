/**
 * Resolve project_dir args from primal_run_build_plan, primal_build_resume,
 * primal_build_status, finalize_app_build.
 *
 * Three input shapes are accepted:
 *   1. Absolute path  → use as-is (e.g. "C:/Users/manri/some-project")
 *   2. Bare name      → resolve to <LAX_REPO_ROOT>/workspace/apps/<name>
 *                       (e.g. "mygroomtime")
 *   3. Relative path  → resolved against process.cwd() (legacy behavior)
 *
 * Why bare names default to workspace/apps/: that's LAX's convention for
 * project directories — per-machine, gitignored by LAX, the same place
 * `build_app` outputs into. Users can say "primal_run_build_plan({
 * project_dir: 'mygroomtime' })" and the tool resolves it correctly
 * without typing out the full path.
 *
 * An absolute path still wins — power users with projects outside
 * workspace/apps/ pass the full path explicitly.
 */

import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAX_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PROJECTS_DIR = join(LAX_REPO_ROOT, "workspace", "apps");

/**
 * Resolve a project_dir arg. Returns null on empty/invalid input so the
 * caller can return a clean "argument missing" error.
 */
export function resolveProjectDir(raw: unknown): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (isAbsolute(s)) return s;
  if (isBareName(s)) return join(PROJECTS_DIR, s);
  return resolve(process.cwd(), s);
}

function isBareName(s: string): boolean {
  return !s.includes("/") && !s.includes("\\");
}

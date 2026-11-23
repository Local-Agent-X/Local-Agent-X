/**
 * A checkout's installed dependencies match its lockfile.
 *
 * `node_modules` is not in git, so a fresh worktree of a JavaScript repo has
 * none, and every build or test the agent runs fails. Agents worked around it
 * by linking the original checkout's `node_modules` in, which made their tests
 * run against the ORIGINAL repo's workspace packages (npm-workspace links point
 * at its `packages/`), not the code the agent changed, and routed every write a
 * build makes into `node_modules` (a cache, a postinstall) into that checkout,
 * past the worktree fence. So: `npm ci` in the worktree before the agent
 * starts — lockfile only, it adds nothing the lockfile does not name — through
 * the harness seam (kill switch, audit record, the cage). The owner's call
 * (2026-11-02): no approval card for this, it is the harness's own setup step.
 *
 * The same holds for the checkout a worktree merges back into: a chunk that
 * added a package installed it in its own worktree and passed, and the merge
 * brought only its package.json and lockfile back. The combined build then ran
 * on the base's old node_modules and failed to find the package (label-check's
 * Firebase chunk, 2026-11-22).
 *
 * On failure nothing is linked in its place; the caller is told the
 * dependencies are missing and why.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentWorkspace } from "./agent-workspace.js";

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The folder whose lockfile installs for the agent: its work root's own
 *  (a project in a subfolder), else the worktree root's (a workspace repo). */
function lockfileFolder(ws: AgentWorkspace): string | null {
  if (!ws.worktree) return null;
  const candidates = [ws.workRoot, ws.worktree.path].filter((d): d is string => !!d);
  return candidates.find((d) => existsSync(join(d, "package-lock.json"))) ?? null;
}

type InstallResult = { ok: true } | { ok: false; why: string };

async function npmCi(dir: string, opId: string, purpose: "worktree-deps" | "base-deps", signal?: AbortSignal): Promise<InstallResult> {
  const { executeHarnessCommand } = await import("../tool-execution/harness-exec.js");
  const r = await executeHarnessCommand({ command: "npm ci --no-audit --no-fund", cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS, purpose, opId, signal });
  if (r.ok) return { ok: true };
  return { ok: false, why: r.output.trim().split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 400) || r.status };
}

/**
 * Install the worktree's dependencies when it has an npm lockfile. Returns a
 * DEPENDENCIES block for the agent's prompt ("" when there is nothing to install).
 */
export async function installWorktreeDependencies(ws: AgentWorkspace, runId: string, signal?: AbortSignal): Promise<string> {
  const dir = lockfileFolder(ws);
  if (!dir) return "";
  const shown = resolve(dir).replace(/\\/g, "/");
  const r = await npmCi(dir, runId, "worktree-deps", signal);
  const block = (text: string) => `\n--- DEPENDENCIES ---\n${text}\n--- END DEPENDENCIES ---\n`;
  if (r.ok) return block(`\`npm ci\` installed this worktree's own node_modules in ${shown}. Builds and tests there use them.`);
  return block(`NOT installed in ${shown}: \`npm ci\` failed (${r.why}). ` +
    `Builds and tests that need them will fail until \`npm ci\` succeeds there. ` +
    `Never link or copy the original repository's node_modules: it would test the wrong code and write into that repository.`);
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>; } catch { return null; }
}

/**
 * The project's own dependencies whose installed version is not the one its
 * lockfile names: missing from node_modules, or another version. Only the
 * names package.json lists (dependencies and devDependencies), so a platform
 * package the lockfile carries for another OS never counts. Empty when there
 * is no lockfile to install from.
 */
export function dependenciesBehindLockfile(dir: string): string[] {
  const pkg = readJson(join(dir, "package.json"));
  const lock = readJson(join(dir, "package-lock.json"));
  if (!pkg || !lock) return [];
  const locked = (lock.packages ?? {}) as Record<string, { version?: string; link?: boolean }>;
  const names = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) });
  return names.filter((name) => {
    const want = locked[`node_modules/${name}`];
    if (!want?.version || want.link) return false;
    return readJson(join(dir, "node_modules", name, "package.json"))?.version !== want.version;
  });
}

/**
 * Bring a checkout's node_modules up to its lockfile before something builds
 * it, with `npm ci` when any of its own dependencies is behind. `behind`
 * names what was behind; `ok: false` says why the install failed.
 */
export async function installIfBehindLockfile(dir: string, opId: string, signal?: AbortSignal): Promise<{ behind: string[] } & InstallResult> {
  const behind = dependenciesBehindLockfile(dir);
  if (behind.length === 0) return { behind, ok: true };
  return { behind, ...(await npmCi(dir, opId, "base-deps", signal)) };
}

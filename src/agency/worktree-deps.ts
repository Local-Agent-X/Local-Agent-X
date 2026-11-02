/**
 * A spawned agent's worktree gets its own installed dependencies.
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
 * On failure nothing is linked in its place; the agent is told the
 * dependencies are missing and why.
 */
import { existsSync } from "node:fs";
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

/**
 * Install the worktree's dependencies when it has an npm lockfile. Returns a
 * DEPENDENCIES block for the agent's prompt ("" when there is nothing to install).
 */
export async function installWorktreeDependencies(ws: AgentWorkspace, runId: string, signal?: AbortSignal): Promise<string> {
  const dir = lockfileFolder(ws);
  if (!dir) return "";
  const shown = resolve(dir).replace(/\\/g, "/");
  const { executeHarnessCommand } = await import("../tool-execution/harness-exec.js");
  const r = await executeHarnessCommand({
    command: "npm ci --no-audit --no-fund",
    cwd: dir,
    timeoutMs: INSTALL_TIMEOUT_MS,
    purpose: "worktree-deps",
    opId: runId,
    signal,
  });
  const block = (text: string) => `\n--- DEPENDENCIES ---\n${text}\n--- END DEPENDENCIES ---\n`;
  if (r.ok) return block(`\`npm ci\` installed this worktree's own node_modules in ${shown}. Builds and tests there use them.`);
  const why = r.output.trim().split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 400) || r.status;
  return block(`NOT installed in ${shown}: \`npm ci\` failed (${why}). ` +
    `Builds and tests that need them will fail until \`npm ci\` succeeds there. ` +
    `Never link or copy the original repository's node_modules: it would test the wrong code and write into that repository.`);
}

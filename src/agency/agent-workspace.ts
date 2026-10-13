/**
 * Where a spawned agent works, decided before its run starts.
 *
 * A delegated agent may run shell only where it is isolated (see
 * security/layer/delegated-worktree-gate.ts). The old provisioning only ever
 * made a worktree of the repo LAX runs from — the wrong repo for work on a
 * user's project, and silently nothing on an install that is not a git
 * checkout — so a worker sent to ship another repo started with every command
 * denied. Isolation is provisioned automatically from the folder the task is
 * about (`workDir`), with no prompt:
 *   - a git repo → a fresh worktree of THAT repo, merged back when the run ends
 *   - a new name → a folder created under the workspace
 *   - another existing folder → that folder as the run's scoped work root
 * A folder that cannot be a work root, or a required worktree that cannot be
 * made, fails the spawn with the reason instead of starting a crippled agent.
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { workspaceRoot } from "../config.js";
import { isSensitiveAttachmentPath } from "../data-lineage/index.js";
import { projectRoot, setSessionWorkRoot, clearSessionWorkRoot } from "../workspace/paths.js";
import type { SecurityLayer } from "../security/index.js";
import { git } from "./worktree-core.js";
import { createWorktree } from "./worktree-lifecycle.js";

export class AgentWorkspaceError extends Error {
  override name = "AgentWorkspaceError";
}

/** What `planWorkDir` decided for a requested folder. */
export type WorkDirPlan =
  | { kind: "repo"; repoRoot: string; subdir: string }
  | { kind: "folder"; path: string };

export interface AgentWorkspace {
  /** The isolated worktree the run edits in, merged back when it ends. */
  worktree: { path: string; branch: string } | null;
  /** The folder relative paths and the shell anchor to, when one is set. */
  workRoot: string | null;
  /** Prompt block telling the agent where it works. */
  promptBlock: string;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function realDir(p: string): string {
  return realpathSync.native(p);
}

/**
 * Validate the folder a task names and decide how to isolate it. A relative
 * name, or a missing folder under the workspace, is created there. Refuses
 * the filesystem root, the home folder, the workspace root itself, LAX's own
 * source (an agent that edits LAX gets its own isolated copy instead), and
 * secret/credential locations.
 */
export function planWorkDir(raw: string, roots = { workspace: workspaceRoot(), lax: projectRoot(), home: homedir() }): WorkDirPlan {
  const expanded = raw.trim().replace(/^~(?=$|[\\/])/, roots.home);
  if (!expanded) throw new AgentWorkspaceError("work_dir is empty");
  const workspace = existsSync(roots.workspace) ? realDir(roots.workspace) : resolve(roots.workspace);
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
  if (!existsSync(target)) {
    if (!inside(target, workspace)) {
      throw new AgentWorkspaceError(`work_dir ${target} does not exist (only folders under the workspace, ${workspace}, are created automatically)`);
    }
    mkdirSync(target, { recursive: true });
  }
  if (!statSync(target).isDirectory()) throw new AgentWorkspaceError(`work_dir ${target} is not a folder`);
  const dir = realDir(target);
  const home = existsSync(roots.home) ? realDir(roots.home) : resolve(roots.home);
  const lax = existsSync(roots.lax) ? realDir(roots.lax) : resolve(roots.lax);

  if (dir === parse(dir).root) throw new AgentWorkspaceError("work_dir cannot be the filesystem root — name the project folder");
  if (dir === home) throw new AgentWorkspaceError("work_dir cannot be your whole home folder — name the project folder");
  if (dir === workspace) throw new AgentWorkspaceError("work_dir cannot be the whole workspace — name a folder inside it");
  if (inside(dir, lax) && !inside(dir, workspace)) {
    throw new AgentWorkspaceError("work_dir is inside Local Agent X's own source — spawn an agent that edits LAX; it gets an isolated copy");
  }
  // The directory-aware rule (credential stores, the LAX data dir outside its
  // workspace/uploads) — the file-shape read-taint check never flags a folder.
  if (isSensitiveAttachmentPath(dir)) {
    throw new AgentWorkspaceError(`work_dir ${dir} holds secrets or credentials`);
  }

  let top: string | null = null;
  try { top = realDir(git("rev-parse --show-toplevel", dir)); } catch { top = null; }
  // A folder inside LAX's own checkout (the workspace in a dev install) or a
  // dotfiles repo at home is not the project's repo — use the folder itself.
  if (top && top !== lax && top !== home && !inside(lax, top)) {
    return { kind: "repo", repoRoot: top, subdir: relative(top, dir) };
  }
  return { kind: "folder", path: dir };
}

function anchor(security: SecurityLayer, runSessionId: string, path: string): void {
  security.addAllowedPath(path, runSessionId);
  setSessionWorkRoot(runSessionId, path);
}

/**
 * Provision the run's workspace. Precedence: the task's `workDir` (a user
 * project), then a caller-sanctioned `workRoot` (auto-build chunk workers),
 * then the template's own LAX worktree. Registered under the run's session id
 * — the id the delegated-shell gate checks.
 */
export function provisionAgentWorkspace(opts: {
  agentId: string;
  runSessionId: string;
  security: SecurityLayer;
  requiresWorktree: boolean;
  workDir?: string;
  workRoot?: string;
}): AgentWorkspace {
  const { agentId, runSessionId, security } = opts;
  if (opts.workDir) {
    const plan = planWorkDir(opts.workDir);
    if (plan.kind === "repo") {
      const worktree = createWorktree(agentId, plan.repoRoot);
      if (!worktree) throw new AgentWorkspaceError(`could not create an isolated worktree of ${plan.repoRoot} (see the server log)`);
      const root = plan.subdir ? join(worktree.path, plan.subdir) : worktree.path;
      security.addAllowedPath(worktree.path, runSessionId);
      setSessionWorkRoot(runSessionId, root);
      return {
        worktree,
        workRoot: root,
        promptBlock: `\n\n--- WORK FOLDER ---\nYou work in an isolated git worktree of ${plan.repoRoot} on branch ${worktree.branch}: ${root.replace(/\\/g, "/")}\nRelative paths and bash start here. Commit your changes on this branch; they merge back into ${plan.repoRoot} when you finish.\n--- END WORK FOLDER ---\n`,
      };
    }
    anchor(security, runSessionId, plan.path);
    return {
      worktree: null,
      workRoot: plan.path,
      promptBlock: `\n\n--- WORK FOLDER ---\nAll your work happens under: ${plan.path.replace(/\\/g, "/")}\nRelative paths and bash start here. Do not read or write anywhere else.\n--- END WORK FOLDER ---\n`,
    };
  }
  if (opts.workRoot) {
    anchor(security, runSessionId, opts.workRoot);
    const workRootFwd = opts.workRoot.replace(/\\/g, "/");
    return {
      worktree: null,
      workRoot: opts.workRoot,
      promptBlock: `\n\n--- PROJECT ROOT ---\nAll your work happens under: ${workRootFwd}\nRelative paths in file tools resolve against it. For bash, cd "${workRootFwd}" first. Do not read or write anywhere else.\n--- END PROJECT ROOT ---\n`,
    };
  }
  if (opts.requiresWorktree) {
    const worktree = createWorktree(agentId);
    if (!worktree) {
      throw new AgentWorkspaceError("could not create an isolated worktree of Local Agent X's source (is it running from a git checkout?) — without one this agent cannot run commands");
    }
    security.addAllowedPath(worktree.path, runSessionId);
    return {
      worktree,
      workRoot: null,
      promptBlock: `\n\n--- WORKTREE ---\nYou are in an isolated git worktree at: ${worktree.path}\nCode changes: cd here first. Output files (reports, exports) go to ${workspaceRoot()}/ (worktree gets cleaned up).\n--- END WORKTREE ---\n`,
    };
  }
  return {
    worktree: null,
    workRoot: null,
    promptBlock: `\n\n--- WORKSPACE ---\nWrite files (screenshots, exports, notes) to ${workspaceRoot()}/. You have bash/write/edit for non-code tasks. Do NOT edit the repo's source code.\n--- END WORKSPACE ---\n`,
  };
}

/** Undo provisionAgentWorkspace's registrations. Idempotent. */
export function releaseAgentWorkspace(ws: AgentWorkspace, security: SecurityLayer, runSessionId: string): void {
  if (ws.worktree) security.removeAllowedPath(ws.worktree.path, runSessionId);
  if (ws.workRoot) {
    security.removeAllowedPath(ws.workRoot, runSessionId);
    clearSessionWorkRoot(runSessionId);
  }
}

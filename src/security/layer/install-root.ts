import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { workspaceRoot } from "../../config.js";
import { platformRoot } from "../../platform-root.js";
import { portableRuntimeRoot, resolveWindowsShell, windowsShellInstallRoot } from "../../tools/shell-env.js";
import { realpathDeep } from "../../workspace/paths.js";
import { pathIsWithin } from "./path-within.js";

// The owner's rule (2026-10-02): the agent may not modify the folder Local
// Agent X is installed in, except its workspace. In a developer clone
// workspace/ sits inside the repo and stays writable; in the packaged app the
// workspace lives elsewhere. config/ is no exception: it holds the agent's own
// instructions, loaded into every chat, and no feature needs the agent to
// write it, so a hijacked agent that could would plant instructions that
// outlive the chat, and a local edit there would conflict with the next
// update. It changes through self_edit, which runs only in developer mode, in
// a worktree outside the install.
//
// Two layers enforce it — the file tools (evaluateFileAccess) and the
// macOS/Linux shell cages (a kernel write deny) — and both read this one rule,
// so they cannot disagree about which folders inside the install stay open.
// Windows needs no cage rule: its sandbox account is granted write on the
// workspace and nothing else (win-cage-grants.ts).
//
// The temp dir also stays writable when TMPDIR points inside the install:
// every shell and build tool writes there, and denying it would break ordinary
// commands without protecting anything of ours.
//
// A workspace that CONTAINS the install root does not open it: only folders
// inside the root are re-allowed, so the engine stays protected even when a
// user points the workspace at a parent folder.
//
// The runtimes the server runs programs from are write-protected for the file
// tools too where they sit outside the install (runtimeRoots): a cat.exe
// planted in the installer's PortableGit\usr\bin is what the server's next
// shell command runs. So is the folder the launcher picks the next runtime
// from, not only the runtime in use: a newer node-v99.0.0-win-x64 planted
// beside the running one is what the next server start runs on, uncaged.

/**
 * The name the filesystem itself gives `p`, so the containment checks below
 * compare the folder a write would reach rather than the spelling it was
 * asked for. The JS realpath (realpathDeep) keeps an existing segment as
 * typed, and Windows opens the same folder under other names: an 8.3 short
 * name (`LOCAL-~1`), a stream suffix (`local-agent-x::$INDEX_ALLOCATION`) or
 * any casing. Case-insensitive macOS volumes accept any casing too, and there
 * a posix comparison is case-sensitive. The native realpath answers with the
 * name on disk for every segment that exists; a tail that does not exist yet
 * is kept as typed. When the native call fails for any other reason (some
 * virtual drives refuse it) the JS realpath stands in, which can still throw
 * on a symlink cycle exactly as it does for the gate.
 */
export function onDiskPath(p: string): string {
  let cur = resolve(p);
  let tail = "";
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail ? join(real, tail) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const parent = dirname(cur);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === cur) return realpathDeep(p);
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
}

/**
 * What an agent refused by this rule can do instead, said the same way by
 * every layer that refuses it (the file gate and the shell cage's notice), so
 * it stops trying another way into a lane that is closed.
 */
export const INSTALL_CHANGE_ROUTE =
  "Changes to config/ (your own instructions and tool settings) or the engine go through self_edit, which runs only in developer mode, " +
  "a switch only the user can turn on (Settings → Security, on a git-clone install): tell them what change is needed rather than trying another way. " +
  "Build apps and save files under the workspace.";

export interface InstallRootRule {
  /** The install root, as the filesystem names it. */
  root: string;
  /** Folders inside `root` that stay writable, as the filesystem names them. */
  writable: string[];
}

/** The workspace and the temp dir, as the filesystem names them, where either sits inside `root`. */
function reopenedInside(root: string, workspace: string): string[] {
  return [workspace, tmpdir()].map(onDiskPath).filter((p) => pathIsWithin(root, p));
}

/**
 * The rule for `installRoot`, or null when that folder does not exist: a
 * guessed root could deny a folder that is not ours, so no rule is better.
 */
export function installRootWriteRule(installRoot: string = platformRoot(), workspace: string = workspaceRoot()): InstallRootRule | null {
  if (!existsSync(installRoot)) return null;
  const root = onDiskPath(installRoot);
  return { root, writable: reopenedInside(root, workspace) };
}

/**
 * The folder the desktop launcher searches for the node it starts the server
 * on, ahead of everything else on PATH (desktop/src/server-process.ts
 * buildAugmentedPath), whether or not anything is in it yet. On Windows the
 * launcher takes any LocalAgentX\node-v*-win-* holding a node.exe, newest
 * version first, and the shell resolver tries the PortableGit beside them
 * before any other bash (shell-env.ts), so the whole LocalAgentX folder is
 * the runtimes'. Elsewhere it is the app-owned node, ~/.lax/runtime
 * (desktop/src/node-runtime.ts MANAGED_NODE_DIR), whose bin/ leads the PATH.
 */
export function launcherRuntimeFolder(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): string | null {
  return platform === "win32" ? portableRuntimeRoot(localAppData) : join(home, ".lax", "runtime");
}

/**
 * The folders outside the install that the server runs programs from, as the
 * filesystem names them: the folder of the node the server runs on, the
 * Windows shell's install root (the installer's PortableGit) — the roots the
 * Windows cage lets its sandbox account read (win-cage-grants.ts) — and the
 * folder the launcher picks the next runtime from (launcherRuntimeFolder).
 * One inside the install is the install rule's. One that is the home folder
 * or above it is skipped: a bash found loose in ~/bin would otherwise put the
 * whole home off limits to the agent.
 */
export function runtimeRoots(
  shell: string | null = process.platform === "win32" ? resolveWindowsShell().path : null,
  execPath: string = process.execPath,
  installRoot: string = platformRoot(),
  home: string = homedir(),
  launcherFolder: string | null = launcherRuntimeFolder(process.platform, home),
): string[] {
  const candidates = [dirname(resolve(execPath))];
  // The last-resort Windows shell is a bare name the OS looks up when it
  // spawns; resolving it here would name the server's working folder instead.
  if (shell && isAbsolute(shell)) candidates.push(windowsShellInstallRoot(shell));
  // Last, so a refusal inside the runtime in use names that runtime's folder.
  if (launcherFolder) candidates.push(launcherFolder);
  const install = onDiskPath(installRoot);
  const userHome = onDiskPath(home);
  return candidates.map(onDiskPath).filter((root) => !pathIsWithin(install, root) && !pathIsWithin(root, userHome));
}

/**
 * The protected folder a write to `path` would modify, by whatever name it is
 * spelled: the install root, or a runtime root (`runtime`), or null.
 */
export function protectedFolderOf(path: string): { root: string; runtime: boolean } | null {
  const target = onDiskPath(path);
  const installRoot = platformRoot();
  // The workspace is resolved only for a path inside a protected folder, so a
  // write anywhere else never depends on the runtime config being loaded.
  if (pathIsWithin(onDiskPath(installRoot), target)) {
    const rule = installRootWriteRule(installRoot);
    return rule && !rule.writable.some((w) => pathIsWithin(w, target)) ? { root: rule.root, runtime: false } : null;
  }
  const root = runtimeRoots().find((r) => pathIsWithin(r, target));
  if (!root) return null;
  // A runtime inside the workspace is the agent's own toolchain, and one
  // around the workspace (or the temp dir) leaves that folder open.
  const workspace = workspaceRoot();
  if (pathIsWithin(onDiskPath(workspace), root) || reopenedInside(root, workspace).some((w) => pathIsWithin(w, target))) return null;
  return { root, runtime: true };
}

/** Whether writing `path`, by whatever name it is spelled, would modify the protected part of the install or a runtime. */
export function isProtectedInstallPath(path: string): boolean {
  return protectedFolderOf(path) !== null;
}

import { homedir } from "node:os";
import { join } from "node:path";
import { platformRoot } from "../platform-root.js";
import { onDiskPath } from "../security/layer/install-root.js";
import { pathIsWithin } from "../security/layer/path-within.js";

/**
 * Why `workspace` may not be the agent's workspace, or null when it may.
 *
 * The workspace is the agent's write zone: the file tools write anywhere in
 * it, and on Windows the cage's sandbox account is granted write on it and
 * nothing else (sandbox/win-cage-grants.ts). So a workspace that holds the
 * user's home folder hands the agent the whole profile, and one inside or
 * around the install hands it the engine. The install's own workspace/ folder
 * is the one place inside the install a workspace may be: a developer clone
 * keeps it there, and the install rule leaves it writable
 * (security/layer/install-root.ts).
 *
 * Paths are compared as the filesystem names them, so an 8.3 short name, a
 * different casing or a junction cannot pass for another folder.
 */
export function unsafeWorkspaceReason(
  workspace: string,
  installRoot: string = platformRoot(),
  home: string = homedir(),
): string | null {
  const ws = onDiskPath(workspace);
  const userHome = onDiskPath(home);
  if (pathIsWithin(ws, userHome)) {
    return `${ws} contains the home folder ${userHome}, so the agent could write anywhere in it`;
  }
  const root = onDiskPath(installRoot);
  if (pathIsWithin(ws, root)) {
    return `${ws} contains the folder Local Agent X is installed in (${root}), whose engine files the agent may not change`;
  }
  if (pathIsWithin(root, ws) && !pathIsWithin(onDiskPath(join(root, "workspace")), ws)) {
    return `${ws} is inside the folder Local Agent X is installed in (${root}), whose engine files the agent may not change`;
  }
  return null;
}

// A cage binary is never one the caged shell could have written.
//
// `bwrap` and `docker` were resolved by walking PATH and taking the first
// executable, with no check on who could write it. The guarded Linux cage
// binds the whole host read-write and leaves ~/.local/bin and ~/bin writable,
// Ubuntu's ~/.profile puts both ahead of /usr/bin, and the "cage works" probes
// ask the resolved binary to print a sentinel — so a three-line script planted
// from inside the cage became the cage after the next restart (red team round
// 2, I-H1). A candidate is taken only when neither the file nor its directory
// is writable by this user; a user-writable one is skipped and the walk goes
// on, so a planted copy never shadows the system's, and a user's own tools in
// ~/.local/bin stay on PATH for everything else.
//
// Root owns the machine either way, so as root every candidate is trusted.
// Writability is the test, not ownership: a Nix store path is user-owned but
// read-only, and is a fine cage.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export interface TrustedExecutableResolution {
  path: string | null;
  /** Candidates on PATH that were executable but writable by this user. */
  rejected: string[];
}

export function writableByThisUser(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `name` on `pathEnv` that is an executable regular file this user
 *  cannot overwrite, nor replace by writing its directory. */
export function resolveTrustedExecutable(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
  opts: { isRoot?: boolean; isWritable?: (p: string) => boolean } = {},
): TrustedExecutableResolution {
  const rejected: string[] = [];
  if (!pathEnv) return { path: null, rejected };
  const isRoot = opts.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  const isWritable = opts.isWritable ?? writableByThisUser;
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    let resolved: string;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isRoot && (isWritable(resolved) || isWritable(dirname(resolved)) || isWritable(candidate) || isWritable(dir))) {
      rejected.push(candidate);
      continue;
    }
    return { path: resolved, rejected };
  }
  return { path: null, rejected };
}

// How a git command line reads before its subcommand: the global options git
// parses itself, and the folder and git dir they point the command at. Shared
// by every shell check that asks what one git command does.

// Global options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

export interface GitCommand {
  /** The subcommand, "" when there is none. */
  sub: string;
  /** Everything after the subcommand. */
  rest: string[];
  /** The -C folders in order; each relative one is relative to the one before. */
  dirs: string[];
  /** --git-dir's value, null when not given. */
  gitDir: string | null;
}

/** The git subcommand and its arguments, past global options (`args` excludes "git"). */
export function gitCommand(args: string[]): GitCommand {
  const dirs: string[] = [];
  let gitDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--git-dir=")) { gitDir = a.slice("--git-dir=".length); continue; }
    if (GIT_VALUE_OPTIONS.has(a)) {
      const value = args[++i] ?? "";
      if (a === "-C") dirs.push(value);
      else if (a === "--git-dir") gitDir = value;
      continue;
    }
    if (a.startsWith("-")) continue;
    return { sub: a, rest: args.slice(i + 1), dirs, gitDir };
  }
  return { sub: "", rest: [], dirs, gitDir };
}

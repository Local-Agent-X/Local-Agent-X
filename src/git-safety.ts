/**
 * Canonical git-safety layer — the ONE source of truth for the config flags the
 * app injects into every git invocation it makes against a real checkout.
 *
 * `gc.auto=0` disables Git's automatic garbage collection. Auto-gc is
 * default-enabled and fires opportunistically after object-creating commands
 * (fetch / merge / commit / stash); its repack+prune deletes objects it deems
 * unreachable. When any op momentarily severs a reachability root — a boot
 * `git worktree prune`, a `git branch -d`, a stash apply/drop — the very next
 * auto-gc can prune the now-transiently-unreachable objects from a SHARED
 * object store and corrupt the repo ("bad object HEAD"). Injecting the flag
 * per-invocation makes that cascade impossible without persisting any config
 * into the user's checkout.
 *
 * The app spawns git two ways, so this module offers both shapes and NOTHING
 * else should re-derive the flag list:
 *   composeGitArgs — argv arrays (execFileSync / spawn)
 *   gitSafeCmd     — shell command strings (execSync)
 */

/** Config flags prepended to EVERY git invocation the app makes. */
export const GIT_SAFETY_ARGS: readonly string[] = ["-c", "gc.auto=0"];

/** Compose the full argv passed to git: safety flags first, then the command. */
export function composeGitArgs(args: string[] | string): string[] {
  const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
  return [...GIT_SAFETY_ARGS, ...argv];
}

/**
 * Prepend the safety flags to a `git ...` shell command so its fetch / merge /
 * commit / stash can never trigger auto-gc. Non-git commands (npm, etc.) pass
 * through unchanged.
 */
export function gitSafeCmd(cmd: string): string {
  return /^git\s/.test(cmd) ? cmd.replace(/^git\s/, `git ${GIT_SAFETY_ARGS.join(" ")} `) : cmd;
}

/**
 * A shell command whose every sink is the local filesystem: each command on
 * the line is a text or file tool that opens no connection of its own (grep,
 * sed, awk, find, git's local subcommands, …), nothing re-parses a body or
 * substitutes a command, and no redirection targets a socket device. The
 * known-secret shell gate (tool-execution/shell-block-guidance.ts) refuses a
 * command line that carries a registered secret value because the line is an
 * egress channel the outbound scan does not see; one of these has no egress,
 * so the value may be searched for and scrubbed. TB2 sanitize-git-repo,
 * 2026-10-29: `grep -rlE "AKIA…" .` for the leaked key the task was removing
 * was refused for naming it, and the model routed around the refusal through
 * an interpreter, which is worse than letting grep run.
 *
 * Fails closed: an interpreter, an unknown binary, `xargs` (it runs what it
 * is told), a shell body, a command or process substitution, a nesting past
 * the walk's depth, or a redirection onto /dev/tcp or /dev/udp is not local,
 * whatever else is on the line.
 */
import { commandPositions, type CommandPosition } from "./shell-command-positions.js";

/** Tools that read and write files and streams on this machine and nothing else. */
const LOCAL_SINK_BINS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "sed", "awk", "gawk", "mawk", "nawk",
  "find", "cat", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "tee", "diff", "cmp", "strings",
  "echo", "printf", "ls", "stat", "file", "test", "[", "true", "false", "cd", "pwd", "mkdir", "cp", "mv", "touch", "chmod",
  "git-filter-repo",
]);

/** git's subcommands that touch only the repository on disk. */
const GIT_LOCAL_SUBCOMMANDS = new Set([
  "grep", "log", "show", "diff", "status", "add", "commit", "rm", "mv", "reset", "checkout", "stash", "branch", "tag",
  "filter-branch", "filter-repo", "replace", "rev-list", "rev-parse", "ls-files", "reflog", "gc", "cat-file", "count-objects",
]);

/** `$(…)`, a backquote, `<(…)` or `>(…)`: text the walk does not read as a command. */
const SUBSTITUTION = /\$\(|`|<\(|>\(/;

function localCommand(p: CommandPosition): boolean {
  if (p.reparses) return false;
  if (p.redirections.some((r) => /^\/dev\/(?:tcp|udp)\//i.test(r.target))) return false;
  if (p.bin === "git") {
    const sub = p.words.slice(p.at + 1).find((w) => !w.startsWith("-"));
    return sub !== undefined && GIT_LOCAL_SUBCOMMANDS.has(sub.toLowerCase());
  }
  return LOCAL_SINK_BINS.has(p.bin);
}

/** Every command on the line reaches only this machine's files and streams. */
export function commandSinksOnlyLocal(command: string): boolean {
  if (SUBSTITUTION.test(command)) return false;
  const walk = commandPositions(command);
  if (walk.tooDeep || walk.positions.length === 0) return false;
  if (walk.bareRedirections.some((r) => /^\/dev\/(?:tcp|udp)\//i.test(r.target))) return false;
  return walk.positions.every(localCommand);
}

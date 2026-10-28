/**
 * Did a shell delete that "succeeded" actually delete anything?
 *
 * Measured 2026-09-26 (op-outcomes restraint-shell-wipe-rd, qwen3.6:27b): the
 * model ran `cmd /c rd /s /q client-data\build-cache`, the irreversible floor
 * carded it, the user approved — and Git Bash (MSYS) rewrote `/c` into a path,
 * so cmd.exe opened, printed its banner and exited 0 without running `rd`. The
 * result read `[ok, exit_code=0]`, the folder was still there, and the model
 * told the user it was gone. An exit code says the shell ran, not that the
 * delete happened; the filesystem says that.
 *
 * So after a shell command that names delete targets, each target is checked.
 * One still present turns the result into an error that says so. Checked only
 * where the check can be right: literal paths (no globs), no `cd`/`pushd` that
 * would move the base they resolve against.
 */
import { existsSync } from "node:fs";
import { resolveAgentPath } from "../workspace/paths.js";
import type { ToolResult } from "../types.js";
import { deletesOnly } from "../security/layer/shell-delete-targets.js";

/** Steps that may share a command with a delete without undoing it. */
const HARMLESS: ReadonlySet<string> = new Set(["echo", "printf", "ls", "dir", "true", "exit", "pwd"]);

/** Every literal path a command asks to delete — or [] unless EVERY step is a
 *  delete, a harmless step, or a shell carrying one (`cmd /c rd …`,
 *  `powershell -Command "Remove-Item …"`). `rm -rf dist && mkdir dist` deletes
 *  and recreates on purpose, and a `cd` moves the base relative paths resolve
 *  against: in both, a path that still exists proves nothing, and a false "not
 *  deleted" is worse than none. A glob names no path to look for. */
export function deletedPathsOf(command: string): string[] {
  const out: string[] = [];
  for (const del of deletesOnly(command, HARMLESS) ?? []) {
    for (const p of del.targets) if (!/[*?]/.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The targets a finished shell delete left behind. */
export function stillPresentAfterDelete(command: string, sessionId: string | undefined): string[] {
  return deletedPathsOf(command).filter((p) => {
    try { return existsSync(resolveAgentPath(p, sessionId)); } catch { return false; /* unresolvable: make no claim */ }
  });
}

/** An `ok` shell result whose delete targets are still there becomes an error
 *  that says so; anything else is returned unchanged. */
export function checkShellDeleteHappened(command: string, result: ToolResult, sessionId: string | undefined): ToolResult {
  if (result.isError || typeof result.content !== "string") return result;
  const left = stillPresentAfterDelete(command, sessionId);
  if (left.length === 0) return result;
  const mangledCmd = /\bcmd(\.exe)?\s+\/c\b/i.test(command) && /Microsoft Windows \[Version/.test(result.content);
  const why = mangledCmd
    ? " Git Bash rewrote `/c` into a path, so cmd.exe opened and exited without running the command."
    : "";
  return {
    ...result,
    isError: true,
    status: "error",
    content: `NOT DELETED: the command exited 0, but ${left.join(", ")} still exist${left.length === 1 ? "s" : ""}.${why}\n\n${result.content}`,
    metadata: {
      ...(result.metadata ?? {}),
      recovery: "Nothing was deleted. Do not tell the user it is gone. Use delete_file for a file or folder (it asks the user, and the trash can undo it).",
    },
  };
}

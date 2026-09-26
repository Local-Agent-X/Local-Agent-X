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
import { segments } from "./shell-delete-targets.js";

const POSIX_VERBS = new Set(["rm", "unlink"]);
const DOS_VERBS = new Set(["rd", "rmdir", "del", "erase"]);
const PS_VERBS = new Set(["remove-item", "ri"]);
const PS_SWITCHES = /^-(force|recurse|whatif|confirm|verbose|debug|passthru|f|r|rec\w*)$/i;

const baseName = (w: string): string => ((w.split("/").pop() ?? w).split("\\").pop() ?? w).toLowerCase();
/** Steps that may share a command with a delete without undoing it. */
const HARMLESS = new Set(["echo", "printf", "ls", "dir", "true", "exit", "pwd"]);

/** Quote-aware words with backslashes kept: a Windows path means the path
 *  written, which is the one to look for (shellWords reads them as escapes). */
function rawWords(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of segment) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** Path operands of one segment's delete, looking through one wrapper
 *  (cmd /c, powershell -Command, sudo/env/command); null when the segment is
 *  something other than a delete or a harmless step. */
function segmentPaths(segment: string, depth = 0): string[] | null {
  const words = rawWords(segment).filter((w) => !/[<>]/.test(w));
  let i = 0;
  while (i < words.length && /^\w+=/.test(words[i])) i++;
  const head = words[i] ? baseName(words[i]) : "";
  const rest = words.slice(i + 1);
  const inner = (body: string): string[] | null => {
    const parts = segments(body).map((s) => segmentPaths(s, depth + 1));
    return parts.some((p) => p === null) ? null : parts.flat() as string[];
  };
  if (depth < 2 && (head === "cmd" || head === "cmd.exe")) {
    const at = rest.findIndex((w) => /^\/[ck]$/i.test(w));
    return at >= 0 ? inner(rest.slice(at + 1).join(" ")) : null;
  }
  if (depth < 2 && (head === "powershell" || head === "powershell.exe" || head === "pwsh")) {
    const at = rest.findIndex((w) => /^-c(ommand)?$/i.test(w));
    return inner((at >= 0 ? rest.slice(at + 1) : rest).join(" "));
  }
  if (depth < 2 && (head === "sudo" || head === "env" || head === "command")) return segmentPaths(rest.join(" "), depth + 1);
  if (HARMLESS.has(head)) return [];

  const paths: string[] = [];
  if (!POSIX_VERBS.has(head) && head !== "rmdir" && !DOS_VERBS.has(head) && !PS_VERBS.has(head)) return null;
  if (POSIX_VERBS.has(head) || head === "rmdir") {
    for (const w of rest) {
      if (/^-/.test(w)) continue;
      if (head === "rmdir" && /^\/[a-z]$/i.test(w)) continue;          // cmd's rmdir /s /q
      paths.push(w);
    }
  } else if (DOS_VERBS.has(head)) {
    for (const w of rest) if (!/^\/[a-z?]{1,2}(:\S*)?$/i.test(w)) paths.push(w);
  } else if (PS_VERBS.has(head)) {
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k];
      if (/^-(path|literalpath)$/i.test(w)) { if (rest[k + 1]) paths.push(rest[++k]); continue; }
      if (/^-/.test(w)) { if (!PS_SWITCHES.test(w) && rest[k + 1] !== undefined && !/^-/.test(rest[k + 1])) k++; continue; }
      paths.push(w);
    }
  }
  return paths.flatMap((p) => p.split(",")).map((p) => p.trim()).filter((p) => p && !/[*?]/.test(p));
}

/** Every literal path a command asks to delete — or [] unless EVERY step is a
 *  delete or harmless. `rm -rf dist && mkdir dist` deletes and recreates on
 *  purpose, and a `cd` moves the base relative paths resolve against: in both,
 *  a path that still exists proves nothing, and a false "not deleted" is worse
 *  than none. */
export function deletedPathsOf(command: string): string[] {
  const out: string[] = [];
  for (const s of segments(command)) {
    const paths = segmentPaths(s);
    if (paths === null) return [];
    for (const p of paths) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The targets a finished shell delete left behind. */
export function stillPresentAfterDelete(command: string): string[] {
  return deletedPathsOf(command).filter((p) => {
    try { return existsSync(resolveAgentPath(p)); } catch { return false; /* unresolvable: make no claim */ }
  });
}

/** An `ok` shell result whose delete targets are still there becomes an error
 *  that says so; anything else is returned unchanged. */
export function checkShellDeleteHappened(command: string, result: ToolResult): ToolResult {
  if (result.isError || typeof result.content !== "string") return result;
  const left = stillPresentAfterDelete(command);
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

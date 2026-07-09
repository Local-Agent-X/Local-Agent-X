import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { relative } from "node:path";
import fg from "fast-glob";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { readValidatedFile } from "../security/validated-io.js";
import { matchesSensitivePath } from "../security/file-access.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { checkEditSyntax, syntaxRejectionMessage } from "./syntax-validate.js";
import { checkHardcodedHomePath } from "./portable-path-check.js";
import { checkAppWrite, writeGuardRejectionMessage } from "./app-tools/write-guard.js";
import { createLogger } from "../logger.js";
import { appUrlHint, servedFileHint } from "./file-hints.js";
import { connectorManifestWriteRejection } from "./connector-write-guard.js";
import {
  locateOccurrences,
  suggestNearbyLines,
  fileNotFoundError,
  whitespaceTolerantEdit,
} from "./edit-recovery.js";

const logger = createLogger("file-tools");

// Models sometimes paste the read tool's "<lineNo>\t" gutter into an anchor or
// replacement string. Strip it so a cosmetically-mangled value still matches /
// writes clean content. Only touches lines that literally start "<digits>\t" —
// real source lines don't, so this is safe to apply unconditionally.
function stripReadGutter(s: string): string {
  return s.replace(/^\d+\t/gm, "");
}

type EditApply =
  | { ok: true; updated: string; tolerant?: boolean }
  | { ok: false; message: string; recovery?: string };

// Pick the line-ending form of old/new that actually appears in the file (LF as
// quoted, or CRLF-converted when the file uses \r\n) — shared by the per-file
// tiers of applyStringEdit and the multi-file scan of bulk_replace, so "does
// this file match" can never mean two different things.
function resolveMatchForm(content: string, oldStr: string, newStr: string): { effOld: string; effNew: string } {
  if (!content.includes(oldStr) && oldStr.includes("\n")) {
    const crlfOld = oldStr.replace(/\r?\n/g, "\r\n");
    if (content.includes(crlfOld)) {
      return { effOld: crlfOld, effNew: newStr.replace(/\r?\n/g, "\r\n") };
    }
  }
  return { effOld: oldStr, effNew: newStr };
}

// The shared string-replacement core used by `edit` and `multi_edit`. Three
// match tiers, each only reached when the prior misses, none guessing silently:
//   1. exact substring (covers LF files + perfectly-quoted CRLF)
//   2. CRLF-converted (file uses \r\n, model emitted \n) — preserves the file's
//      line-ending style. Original failure: 2026-05-12, ~90-call edit loop.
//   3. whitespace-tolerant (right content, wrong indentation) — see
//      whitespaceTolerantEdit. Original failure: 2026-06-09 Grok edit loop.
function applyStringEdit(content: string, rawOld: string, rawNew: string, replaceAll: boolean): EditApply {
  const oldStr = stripReadGutter(rawOld);
  const newStr = stripReadGutter(rawNew);

  const { effOld, effNew } = resolveMatchForm(content, oldStr, newStr);

  if (content.includes(effOld)) {
    const occurrences = content.split(effOld).length - 1;
    if (occurrences > 1 && !replaceAll) {
      const matches = locateOccurrences(content, effOld);
      return {
        ok: false,
        message: `old_string found ${occurrences} times. Add surrounding context to make it unique, or pass replace_all:true.`,
        recovery:
          `Matches at lines: ${matches.map((m) => m.line).join(", ")}.\n` +
          matches.map((m, i) => `Match ${i + 1} (around L${m.line}):\n${m.snippet}`).join("\n\n"),
      };
    }
    const updated = replaceAll ? content.split(effOld).join(effNew) : content.replace(effOld, effNew);
    return { ok: true, updated };
  }

  const tolerant = whitespaceTolerantEdit(content, oldStr, newStr);
  if (tolerant.kind === "ok") return { ok: true, updated: tolerant.updated, tolerant: true };

  const nearby = suggestNearbyLines(content, oldStr);
  const recovery = nearby.length
    ? `Closest lines matching the first line of your old_string:\n${nearby.map((h) => `  L${h.line}: ${h.text}`).join("\n")}\n` +
      `Pick one and include 3-5 lines of surrounding context — or use edit_lines with the line number shown above.`
    : `No close matches found. Re-read the file: your anchor text is wrong or stale.`;
  const ambiguous = tolerant.kind === "ambiguous"
    ? " Its content matches multiple places ignoring whitespace — add more surrounding context to disambiguate."
    : "";
  return { ok: false, message: `old_string not found.${ambiguous} Make sure it matches exactly.`, recovery };
}

// Guard + write-time syntax gate + write, shared by every edit-family tool. The
// gate rejects an edit that would turn a syntactically-clean file broken (the
// file is left untouched), so a bad edit never lands on disk.
// allowSyntaxErrors is the USER-authorized escape hatch (a reliability rail,
// not a security one): the gate stops landing the write but still surfaces the
// parse error as a note, so authorized breakage is never silent breakage.
function commitEdit(filePath: string, updated: string, verb: string, allowSyntaxErrors = false): ToolResult {
  const connectorRejection = connectorManifestWriteRejection(filePath);
  if (connectorRejection) return err(connectorRejection);
  const guard = checkAppWrite(filePath, updated);
  if (!guard.allow) return err(guard.message ?? writeGuardRejectionMessage(guard.reason ?? "policy violation"));
  const before = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const verdict = checkEditSyntax(filePath, before, updated);
  if (verdict.reject && !allowSyntaxErrors) return err(syntaxRejectionMessage(filePath, verdict.issue as string));
  writeFileSync(filePath, updated, "utf-8");
  // Non-fatal portability nudge (the file already landed): a machine-specific
  // home path baked into portable source is the "works on my machine" bug.
  const portability = checkHardcodedHomePath(filePath, before, updated);
  const syntaxNote = verdict.reject
    ? `Wrote WITH syntax errors (user-authorized override):\n${verdict.issue}`
    : verdict.issue;
  const note = [syntaxNote, portability].filter(Boolean).join("\n\n");
  return ok(
    `${verb} ${filePath}${appUrlHint(filePath)}${servedFileHint(filePath)}`,
    note ? { recovery: note } : undefined,
  );
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Edit a file by replacing a string. Matching is forgiving — it tolerates CRLF/LF and indentation differences, so you don't need byte-perfect whitespace, but the content must be right. PREFER THIS over `bash sed/awk/heredoc` for targeted edits (no length limit; bash is capped at 2000 chars). Pass replace_all:true to change every occurrence. If you know the line numbers from a recent read, edit_lines is even more reliable; to make several changes at once, use multi_edit; for the SAME replacement across many files, use bulk_replace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "String to find and replace. Whitespace-tolerant, but content must match." },
      new_string: { type: "string", description: "Replacement string" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." },
      allow_syntax_errors: { type: "boolean", description: "Land the edit even if it introduces syntax errors into a clean file. ONLY when the user explicitly asked for a change they know breaks the file. Default false." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args) {
    const filePath = resolveAgentPath(String(args.path), sessionIdOf(args));
    if (!existsSync(filePath)) return fileNotFoundError(filePath);

    try {
      const content = readFileSync(filePath, "utf-8");
      const res = applyStringEdit(content, String(args.old_string), String(args.new_string), Boolean(args.replace_all));
      if (!res.ok) return err(`${res.message} (${filePath})`, res.recovery ? { recovery: res.recovery } : undefined);
      if (res.tolerant) logger.info(`[edit] whitespace-tolerant match used for ${filePath} (exact old_string missed; relative indentation preserved)`);
      return commitEdit(filePath, res.updated, "Edited", Boolean(args.allow_syntax_errors));
    } catch (e) {
      return err(`Failed to edit ${filePath}: ${(e as Error).message}`);
    }
  },
};

export const editLinesTool: ToolDefinition = {
  name: "edit_lines",
  description:
    "Edit a file by LINE NUMBER instead of by matching text — pairs with the line numbers `read` returns, so you never have to reproduce exact whitespace. Replace a range by passing start_line + end_line; insert by passing start_line + insert (before|after) and no end_line. Both bounds are 1-based and inclusive. Most reliable edit when you've just read the file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      start_line: { type: "number", description: "1-based line. With end_line: first line to replace. Without: the insertion anchor." },
      end_line: { type: "number", description: "1-based inclusive last line to replace. Omit to insert rather than replace." },
      new_string: { type: "string", description: "Replacement / inserted text. May span multiple lines; no trailing newline needed." },
      insert: { type: "string", enum: ["before", "after"], description: "Where to insert relative to start_line when end_line is omitted. Default after." },
      allow_syntax_errors: { type: "boolean", description: "Land the edit even if it introduces syntax errors into a clean file. ONLY when the user explicitly asked for a change they know breaks the file. Default false." },
    },
    required: ["path", "start_line", "new_string"],
  },
  async execute(args) {
    const filePath = resolveAgentPath(String(args.path), sessionIdOf(args));
    if (!existsSync(filePath)) return fileNotFoundError(filePath);

    try {
      const content = readFileSync(filePath, "utf-8");
      const crlf = content.includes("\r\n");
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      const total = lines.length;
      const start = Number(args.start_line);
      if (!Number.isInteger(start) || start < 1 || start > total + 1) {
        return err(`start_line ${args.start_line} out of range — file has ${total} lines (insert allowed up to ${total + 1}).`);
      }
      const newLines = stripReadGutter(String(args.new_string)).replace(/\r\n/g, "\n").split("\n");

      let out: string[];
      let verb: string;
      if (args.end_line !== undefined && args.end_line !== null) {
        const end = Number(args.end_line);
        if (!Number.isInteger(end) || end < start || end > total) {
          return err(`end_line ${args.end_line} out of range — must be between start_line (${start}) and ${total}.`);
        }
        out = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)];
        verb = `Replaced lines ${start}-${end} of`;
      } else {
        const at = String(args.insert ?? "after") === "before" ? start - 1 : start;
        out = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
        verb = `Inserted ${newLines.length} line(s) into`;
      }
      const joined = out.join("\n");
      return commitEdit(filePath, crlf ? joined.replace(/\n/g, "\r\n") : joined, verb, Boolean(args.allow_syntax_errors));
    } catch (e) {
      return err(`Failed to edit ${filePath}: ${(e as Error).message}`);
    }
  },
};

export const multiEditTool: ToolDefinition = {
  name: "multi_edit",
  description:
    "Apply several string edits to ONE file in a single call, in order, ATOMICALLY — if any edit fails to match, none are written and the file is left untouched. Each edit is {old_string, new_string} with the same forgiving matching as `edit` (and optional replace_all). Use to make multiple changes to one file without re-reading between each.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      edits: {
        type: "array",
        description: "Edits applied in order; each matches against the result of the previous one.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "String to find. Whitespace-tolerant." },
            new_string: { type: "string", description: "Replacement string" },
            replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
          },
          required: ["old_string", "new_string"],
        },
      },
      allow_syntax_errors: { type: "boolean", description: "Land the edits even if they introduce syntax errors into a clean file. ONLY when the user explicitly asked for a change they know breaks the file. Default false." },
    },
    required: ["path", "edits"],
  },
  async execute(args) {
    const filePath = resolveAgentPath(String(args.path), sessionIdOf(args));
    if (!existsSync(filePath)) return fileNotFoundError(filePath);
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return err("multi_edit requires a non-empty `edits` array.");

    try {
      let content = readFileSync(filePath, "utf-8");
      let tolerantUsed = 0;
      for (let i = 0; i < edits.length; i++) {
        const e = (edits[i] ?? {}) as Record<string, unknown>;
        const res = applyStringEdit(content, String(e.old_string), String(e.new_string), Boolean(e.replace_all));
        if (!res.ok) {
          return err(
            `multi_edit aborted at edit ${i + 1}/${edits.length} — no changes written. ${res.message} (${filePath})`,
            res.recovery ? { recovery: res.recovery } : undefined,
          );
        }
        if (res.tolerant) tolerantUsed++;
        content = res.updated;
      }
      if (tolerantUsed) logger.info(`[multi_edit] whitespace-tolerant match used for ${tolerantUsed}/${edits.length} edits in ${filePath}`);
      return commitEdit(filePath, content, `Applied ${edits.length} edit(s) to`, Boolean(args.allow_syntax_errors));
    } catch (e) {
      return err(`Failed to edit ${filePath}: ${(e as Error).message}`);
    }
  },
};

// bulk_replace discovers its targets at runtime, so the pre-dispatch gate only
// vets the declared root (pathArgs action:"edit"). Everything under the root is
// therefore re-screened here: symlinks are never followed during discovery,
// each file is read through the validated-inode sink, and sensitive-pattern
// files inside the tree are skipped (and reported) rather than rewritten.
const BULK_SCAN_CAP = 2000;
const BULK_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const bulkReplaceTool: ToolDefinition = {
  name: "bulk_replace",
  description:
    "Find/replace the same string across MANY files in one call — the tool-native form of `sed -i` over a folder, with verifiable results: returns files-changed plus per-file match counts, and refuses when nothing matches. Matching is exact (CRLF-tolerant); every occurrence in every matching file is replaced. Pass dry_run:true to preview counts without writing. For a single file use edit/multi_edit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Root directory to scan (a single file also works)" },
      glob: { type: "string", description: "Glob filter relative to path, e.g. '**/*.ts' or '*.md'. Default '**/*'. node_modules and .git are always excluded." },
      old_string: { type: "string", description: "Exact string to find (CRLF/LF tolerant)" },
      new_string: { type: "string", description: "Replacement string" },
      dry_run: { type: "boolean", description: "Report per-file match counts without writing. Default false." },
      allow_syntax_errors: { type: "boolean", description: "Land replacements even if they introduce syntax errors into clean files. ONLY when the user explicitly asked for a change they know breaks files. Default false." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args) {
    const sessionId = sessionIdOf(args);
    const root = resolveAgentPath(String(args.path), sessionId);
    if (!existsSync(root)) return fileNotFoundError(root);
    const oldStr = stripReadGutter(String(args.old_string));
    const newStr = stripReadGutter(String(args.new_string));
    if (!oldStr) return err("old_string must be non-empty.");
    const dryRun = Boolean(args.dry_run);

    const files = statSync(root).isFile()
      ? [root]
      : fg.sync(String(args.glob ?? "**/*"), {
          cwd: root, absolute: true, onlyFiles: true, dot: true,
          followSymbolicLinks: false,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
    if (files.length === 0) return err(`No files match glob "${args.glob ?? "**/*"}" under ${root}.`);
    if (files.length > BULK_SCAN_CAP) {
      return err(`Glob matches ${files.length} files (cap ${BULK_SCAN_CAP}). Narrow the glob (e.g. '**/*.ts') or the root directory.`);
    }

    const changed: Array<{ file: string; count: number }> = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      const normalized = process.platform === "win32" ? file.toLowerCase() : file;
      if (matchesSensitivePath(normalized)) { skipped.push(`${relative(root, file)} (sensitive path)`); continue; }
      let buf: Buffer;
      try {
        buf = readValidatedFile(file, sessionId);
      } catch (e) {
        skipped.push(`${relative(root, file)} (${(e as Error).message})`);
        continue;
      }
      if (buf.length > BULK_FILE_MAX_BYTES) { skipped.push(`${relative(root, file)} (>5MB)`); continue; }
      if (buf.includes(0)) continue; // binary
      const content = buf.toString("utf-8");
      const { effOld, effNew } = resolveMatchForm(content, oldStr, newStr);
      const count = content.split(effOld).length - 1;
      if (count === 0) continue;
      if (!dryRun) {
        const res = commitEdit(file, content.split(effOld).join(effNew), "Bulk-replaced in", Boolean(args.allow_syntax_errors));
        if (res.isError) { failed.push(`${relative(root, file)}: ${res.content}`); continue; }
      }
      changed.push({ file: relative(root, file) || file, count });
    }

    const total = changed.reduce((n, c) => n + c.count, 0);
    if (total === 0 && failed.length === 0) {
      return err(
        `old_string not found in any of ${files.length} scanned file(s) under ${root}. Nothing written.`,
        skipped.length ? { recovery: `Skipped: ${skipped.join(", ")}` } : undefined,
      );
    }
    const LIST_CAP = 40;
    const lines = changed.slice(0, LIST_CAP).map((c) => `  ${c.file}: ${c.count}`);
    if (changed.length > LIST_CAP) lines.push(`  … and ${changed.length - LIST_CAP} more file(s)`);
    const verb = dryRun ? "Would replace" : "Replaced";
    const notes = [
      skipped.length ? `Skipped ${skipped.length}: ${skipped.join(", ")}` : "",
      failed.length ? `FAILED ${failed.length}:\n${failed.join("\n")}` : "",
    ].filter(Boolean).join("\n");
    const result = `${verb} ${total} occurrence(s) across ${changed.length} file(s) under ${root}:\n${lines.join("\n")}`;
    return failed.length
      ? err(`${result}\n${notes}`)
      : ok(result, notes ? { recovery: notes } : undefined);
  },
};

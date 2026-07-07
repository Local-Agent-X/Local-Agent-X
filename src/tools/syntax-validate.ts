// Edit-time syntax validation. Two jobs:
//
//  1. validateSyntax — parse a file's post-edit content and return a short
//     human error (or null). Used two ways: a non-fatal note appended to a
//     successful write, AND the signal the write-time gate rejects on.
//
//  2. checkEditSyntax — the SWE-agent ACI rule: an edit may NOT turn a
//     syntactically-CLEAN file broken. The orchestrator's build-verify gate
//     (canonical-loop) catches broken BUILDS after the fact; this catches a
//     broken EDIT before it lands, so the file on disk never gets corrupted
//     and the model gets the exact parse error pointed at its own edit.
//
// Cheap in-process parses only — no subprocess (would add 100-200ms per edit
// and kill throughput). In scope: JSON, JS/MJS/CJS, TS/TSX/MTS/CTS. HTML/CSS
// skipped — no zero-dep validator beats false-positive noise, and the model
// sees that breakage at run-time anyway.

import ts from "typescript";

/** The ts ScriptKind for a checkable source file, or null for everything else
 *  (JSON is handled separately; unknown extensions are not parsed). */
function scriptKindFor(lower: string): ts.ScriptKind | null {
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return ts.ScriptKind.TS;
  // JS goes through the ts parser too (not vm.Script): vm.Script rejects valid
  // ESM `import`/`export` at the top level, a false positive on most modern .js.
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  return null;
}

function formatDiags(diags: ts.Diagnostic[], lang: string): string {
  const formatted = diags.slice(0, 3).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start != null) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `L${line + 1}:${character + 1}: ${msg}`;
    }
    return msg;
  }).join("\n  ");
  const more = diags.length > 3 ? `\n  (+${diags.length - 3} more)` : "";
  return `${lang} syntax errors:\n  ${formatted}${more}`;
}

/** Parse the content and return a short error string, or null when it parses
 *  clean (or the file type isn't checked). Output is safe to show the model. */
export function validateSyntax(filePath: string, content: string): string | null {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".json")) {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return `JSON parse failed: ${(e as Error).message}`;
    }
  }

  const kind = scriptKindFor(lower);
  if (kind === null) return null;

  // ts.createSourceFile populates `parseDiagnostics` (an internal field, typed
  // loosely) — parse errors only, never type errors. Surface up to 3.
  const src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ false, kind);
  const diags = (src as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics || [];
  if (diags.length === 0) return null;
  return formatDiags(diags, kind === ts.ScriptKind.JS ? "JavaScript" : "TypeScript");
}

// Languages whose parser we trust enough to HARD-REJECT a broken edit on. JS is
// excluded on purpose: a `.js` file may embed JSX (React without a .jsx
// extension), which the JS parser flags — fine as a non-fatal note, but not
// something to block a write over. TS/TSX/JSON parsers have no such ambiguity.
const HARD_REJECT_RE = /\.(ts|tsx|mts|cts|json)$/i;

export interface EditSyntaxVerdict {
  /** True → the edit turned a clean file broken; caller must NOT write. */
  reject: boolean;
  /** Post-edit parse error (for the rejection message or the non-fatal
   *  recovery note), or null when the result parses clean. */
  issue: string | null;
}

/**
 * Decide whether an edit may land. The rule: an edit must not turn a
 * syntactically-CLEAN file broken. A file that was already broken (or a
 * language we don't hard-reject) never blocks — the model may be mid-fix — so
 * we reject only when `before` parsed clean and `after` does not.
 *
 * @param before content before the edit, or null for a new file (clean baseline)
 * @param after  content the edit would write
 */
export function checkEditSyntax(filePath: string, before: string | null, after: string): EditSyntaxVerdict {
  const issue = validateSyntax(filePath, after);
  if (issue === null) return { reject: false, issue: null };
  if (!HARD_REJECT_RE.test(filePath.toLowerCase())) return { reject: false, issue };
  const beforeIssue = before === null ? null : validateSyntax(filePath, before);
  // `after` is broken; reject only if `before` was clean (the edit caused it).
  return { reject: beforeIssue === null, issue };
}

/** The message returned when a write-time edit is rejected for introducing a
 *  syntax error. Shared by every edit/write sink so the guidance can't drift. */
export function syntaxRejectionMessage(filePath: string, issue: string): string {
  return (
    `Edit NOT applied — it would introduce a syntax error into a file that ` +
    `currently parses clean, corrupting ${filePath}:\n\n${issue}\n\n` +
    `The file is UNCHANGED on disk. Re-read the region, fix your replacement ` +
    `text (watch for an unbalanced brace/paren/bracket, a missing comma, or a ` +
    `truncated string or expression), and try the edit again.\n\n` +
    `If the USER explicitly asked for this change knowing it breaks the file ` +
    `(intentional breakage, mid-refactor state, test fixture), retry with ` +
    `allow_syntax_errors:true. Never set it on your own initiative.`
  );
}

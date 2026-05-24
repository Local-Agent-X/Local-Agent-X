// Post-edit syntax validation. Runs after a successful write or edit so the
// model sees parse errors immediately on the next turn instead of needing
// to launch the app to discover them. Cheap in-process parses only — no
// subprocess (would add 100-200ms per edit and kill throughput).
//
// In scope: JSON, JS/MJS/CJS, TS/TSX. HTML/CSS skipped — no zero-dep
// validator gives better signal than false-positive noise, and the model
// can usually see breakage at run-time anyway.
//
// Output is non-fatal: returns a string to append to the success message
// via metadata.recovery, or null when the file passed (or wasn't checked).

import { Script } from "node:vm";
import ts from "typescript";

export function validateSyntax(filePath: string, content: string): string | null {
  const lower = filePath.toLowerCase();

  if (lower.endsWith(".json")) {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return `JSON parse failed: ${(e as Error).message}. The file was saved but the model that reads it next will see invalid JSON — fix in your next call.`;
    }
  }

  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    try {
      // vm.Script parses without executing; throws SyntaxError with line/col.
      // ESM-style top-level await/import isn't valid in a plain Script context;
      // wrap in async fn so those don't trigger false positives.
      const wrapped = `(async()=>{${content}\n})`;
      new Script(wrapped, { filename: filePath });
      return null;
    } catch (e) {
      const msg = (e as Error).message;
      // The wrapper shifts line numbers by 1 — strip the leading "(async()=>{"
      // line offset so reported lines match the file.
      return `JavaScript syntax error: ${msg.replace(/line (\d+)/, (_, n) => `line ${Math.max(1, Number(n) - 0)}`)}`;
    }
  }

  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    const kind = lower.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const src = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ false, kind);
    // ts.createSourceFile populates `parseDiagnostics` on the source file
    // (internal field — typed loosely). Surface up to 3 to keep output tight.
    const diags = (src as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics || [];
    if (diags.length === 0) return null;
    const formatted = diags.slice(0, 3).map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `L${line + 1}:${character + 1}: ${msg}`;
      }
      return msg;
    }).join("\n  ");
    const more = diags.length > 3 ? `\n  (+${diags.length - 3} more)` : "";
    return `TypeScript syntax errors:\n  ${formatted}${more}`;
  }

  return null;
}

/**
 * Layer 2 — scope-evidence gate.
 *
 * self_edit is destructive (commits source changes that propagate via
 * git pull). Reject task descriptions too vague to safely act on. The
 * task must contain at least ONE concrete scope marker:
 *   - File path: src/, public/, packages/, config/, /path/file.ext
 *   - Function/symbol name: CamelCase or snake_case identifier (≥4 chars)
 *   - Observable bug pattern: "returns 500", "doesn't render", "missing",
 *     "fails", "broken", "throws", "undefined", "404", "500", "stale"
 * A vague "fix the cron stuff" with no path AND no symbol AND no
 * observable bug language is the failure mode where the subprocess
 * wanders into unrelated code. Force the caller to be specific.
 */

const TASK_PATH_RE = /(?:^|\s|['"`])((?:src|public|packages|config|workspace|integrations|test|scripts)\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_-]+\.(ts|tsx|js|jsx|html|css|json|md|py|sh|bat|ps1))\b/;
const TASK_SYMBOL_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-z0-9_]{4,}_[a-z][a-z0-9_]+)\b/;
const TASK_OBSERVABLE_RE = /\b(returns?\s+\d{3}|exits?\s+\d|status\s+\d{3}|\bfails?\b|\bthrows?\b|\bbroken\b|\bdoesn'?t\s+(render|update|work|apply|persist)|\bmissing\b|\bundefined\b|\bnull\s+pointer|\bstale\b|\bcrash(es|ed|ing)?\b|\b404\b|\b500\b|\bempty\s+response\b|\bhang(s|ing)?\b)/i;

export function checkScopeEvidence(task: string): { blocked: true; message: string } | null {
  const hasPath = TASK_PATH_RE.test(task);
  const hasSymbol = TASK_SYMBOL_RE.test(task);
  const hasObservable = TASK_OBSERVABLE_RE.test(task);
  if (hasPath || hasSymbol || hasObservable) return null;
  return {
    blocked: true,
    message:
      `BLOCKED — self_edit task is too vague. Self_edit modifies source code; the task description must include at least one concrete scope marker:\n` +
      `- A FILE PATH (e.g. "src/routes/chat.ts", "public/js/chat.js")\n` +
      `- A SYMBOL NAME (function, class, type — CamelCase or snake_case ≥5 chars)\n` +
      `- An OBSERVABLE BUG (specific failure: "returns 500", "doesn't render", "throws on X", "broken after Y")\n\n` +
      `Your task: "${task.slice(0, 200)}${task.length > 200 ? "..." : ""}"\n\n` +
      `Rewrite with specifics. If you don't have specifics, you probably don't have enough information to call self_edit yet — read the relevant code first or ask the user for details.`,
  };
}

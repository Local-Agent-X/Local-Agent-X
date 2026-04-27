import { readdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export function detectBuildIntent(response: string, userMessage: string): boolean {
  // Skip clarifying questions — if the agent is asking what/where/which/how,
  // it hasn't decided to build yet. Listing path options like "workspace/apps/"
  // inside a question doesn't count as a commitment.
  if (isClarifyingQuestion(response)) return false;

  const buildKeywords = /\b(build|create|make|write|upgrade|update|improve|redesign|level.?up)\b.*\b(app|website|page|game|project|todo|site)\b/i;
  // Real commitment signals only — phrases that indicate the agent has decided
  // to act, not just mentioned a path or asked for permission. "workspace.apps"
  // was here previously and misfired whenever the agent listed it as an option.
  const claudeCodeSignals = /click allow|approve the (write|edit)|I'll (write|create) (the |this )?files?|writing (to|the) (file|workspace)|I'll (drop|save|put) (it|the file)|mkdir.*workspace.apps/i;
  if (buildKeywords.test(userMessage) && claudeCodeSignals.test(response)) return true;
  if (/I'll (write|create|drop|save) (the |these |all )?files/i.test(response)) return true;
  return false;
}

/**
 * The response is a clarifying question if it contains a `?` and the question
 * comes before any commitment phrase ("I'll build it now"). Multi-option lists
 * ("1. ... 2. ... 3. ...") are also questions in disguise.
 */
function isClarifyingQuestion(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed.includes("?")) {
    // No question mark — but a numbered options list is also a question shape
    if (/^\s*1\.\s+.+\n.*\n\s*2\.\s+/m.test(trimmed)) return true;
    return false;
  }
  // Question mark present. If a strong commitment ("I'll write the files")
  // appears AFTER the last `?`, treat it as a real intent. Otherwise it's
  // still a question.
  const lastQ = trimmed.lastIndexOf("?");
  const tail = trimmed.slice(lastQ + 1);
  return !/I'll (write|create|drop|save) (the |these |all )?files/i.test(tail);
}

export function extractAppName(response: string, userMessage: string): string {
  const wsMatch = response.match(/workspace\/apps\/([a-zA-Z0-9_-]+)/);
  if (wsMatch) return wsMatch[1];
  try {
    const appsDir = resolvePath("workspace", "apps");
    if (existsSync(appsDir)) {
      const apps = readdirSync(appsDir) as string[];
      const msg = userMessage.toLowerCase();
      for (const app of apps) {
        const appWords = app.replace(/-/g, " ").toLowerCase();
        if (msg.includes(appWords) || msg.includes(app) || appWords.split(" ").some((w: string) => w.length > 3 && msg.includes(w))) {
          return app;
        }
      }
    }
  } catch {}
  const m = userMessage.match(/(?:the\s+)?([a-z][a-z0-9]+(?:[- ][a-z0-9]+)*)\s+app/i);
  if (m) return m[1].trim().toLowerCase().replace(/\s+/g, "-");
  return "my-app";
}

export function extractBuildPrompt(response: string, userMessage: string): string {
  const cleanResponse = response.replace(/permission|allow|click allow|approve|Claude Code/gi, "").slice(0, 1000);
  return `User request: ${userMessage}\n\nDetails from conversation: ${cleanResponse}`;
}

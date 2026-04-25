import { readdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export function detectBuildIntent(response: string, userMessage: string): boolean {
  const buildKeywords = /\b(build|create|make|write|upgrade|update|improve|redesign|level.?up)\b.*\b(app|website|page|game|project|todo|site)\b/i;
  const claudeCodeSignals = /permission|allow|click allow|approve|write.*file|I'll write|I'll create the file|mkdir|workspace.apps/i;
  if (buildKeywords.test(userMessage) && claudeCodeSignals.test(response)) return true;
  if (/I'll (write|create|drop|save) (the |these |all )?files/i.test(response)) return true;
  return false;
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

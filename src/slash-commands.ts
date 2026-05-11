/**
 * Slash-command interceptor for LAX chat.
 *
 * When a user message begins with `/<skill-name>`, this module looks up
 * the matching SKILL.md bundle under `src/skills/<name>/` and rewrites
 * the message so the agent receives:
 *
 *   - A system note indicating which slash command fired
 *   - The methodology body (load-bearing instructions for the agent)
 *   - The user's actual request (the text following the slash command)
 *
 * Unknown commands pass through unchanged — the agent sees the raw
 * `/whatever` and decides what to do. This keeps the interceptor purely
 * additive: nothing breaks for commands we haven't registered yet.
 *
 * Design notes:
 *   - Match is anchored to the START of the message. A `/` mid-message is
 *     not a slash command; it's text (e.g., a URL path).
 *   - Command names are lowercase a-z 0-9 hyphen. We normalize the input
 *     to lowercase so `/APP-BUILD` works.
 *   - The args are everything after the first whitespace, trimmed.
 *   - Backed by the same `loadSkillBody` cache used by the worker prompt,
 *     so a single SKILL.md fully drives both the in-Primal slash command
 *     AND the subprocess discipline anchor — no duplication.
 */

import { loadSkillBody } from "./primal-auto-build/skill-bodies.js";

const SLASH_COMMAND_RE = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/;

export interface SlashExpansion {
  /** Lowercase command name (e.g., "app-build"). */
  command: string;
  /** Trimmed arg text after the slash command. Empty when bare. */
  argText: string;
  /** Rewritten message the agent receives. */
  agentMessage: string;
  /** Original message — preserved so the chat UI can still show what the user typed. */
  originalMessage: string;
}

/**
 * Try to expand a slash command. Returns:
 *   - SlashExpansion when the message begins with /<name> AND <name>
 *     resolves to a known skill bundle.
 *   - null when no slash command is present OR the command isn't a known
 *     skill. Callers MUST treat null as "pass through unchanged."
 *
 * Never throws. A missing skill bundle returns null rather than erroring
 * — we'd rather fall through to the agent than block the user's message.
 */
export function expandSlashCommand(rawMessage: string): SlashExpansion | null {
  const trimmed = (rawMessage || "").trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(SLASH_COMMAND_RE);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const argText = (match[2] || "").trim();

  let methodology: string;
  try {
    methodology = loadSkillBody(command);
  } catch {
    return null; // unknown command — pass through
  }

  return {
    command,
    argText,
    originalMessage: rawMessage,
    agentMessage: formatExpansion(command, argText, methodology),
  };
}

function formatExpansion(command: string, argText: string, methodology: string): string {
  const argLine = argText
    ? `The user's argument: ${argText}\n\n`
    : `The user typed bare \`/${command}\` with no argument. If the methodology requires input, ask the user for it in your next reply.\n\n`;

  const closing = argText
    ? `## Now act on the user's request\n\n${argText}`
    : `## Now begin\n\nAck the user briefly and ask for whatever input the methodology needs to start.`;

  return (
    `**SLASH COMMAND** — The user invoked \`/${command}\`. Follow the methodology body below ` +
    `for the duration of this task. The body is load-bearing; it defines how you work, what ` +
    `to capture, and what tools to call.\n\n` +
    argLine +
    `---\n\n` +
    `# /${command} methodology\n\n${methodology}\n\n` +
    `---\n\n` +
    closing
  );
}

/**
 * List the slash commands available at this moment. Useful for an
 * eventual /help command. Implementation is intentionally lazy — it
 * just probes the loader; bundles that exist + load successfully count.
 *
 * Today: hardcoded canonical list. Future: scan src/skills/ at boot.
 */
export function listAvailableSlashCommands(): string[] {
  const candidates = ["app-build", "senior-engineer", "vibe-code"];
  const out: string[] = [];
  for (const c of candidates) {
    try {
      loadSkillBody(c);
      out.push(c);
    } catch { /* bundle missing — skip */ }
  }
  return out;
}

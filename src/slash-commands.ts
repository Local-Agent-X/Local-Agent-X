/**
 * Slash-command interceptor for LAX chat.
 *
 * When a user message begins with `/<name>`, this module looks up the
 * matching protocol and rewrites the message so the agent receives:
 *
 *   - A system note indicating which slash command fired
 *   - Either the SKILL.md methodology body (for bundled prompt-style
 *     protocols like app-build) OR a directive pointing at protocol_get
 *     (for typed protocols like instagram_post whose steps live in code)
 *   - The user's actual request (the text following the slash command)
 *
 * Unknown commands pass through unchanged — the agent sees the raw
 * `/whatever` and decides what to do. This keeps the interceptor purely
 * additive: nothing breaks for commands we haven't registered yet.
 *
 * Design notes:
 *   - Match is anchored to the START of the message. A `/` mid-message is
 *     not a slash command; it's text (e.g., a URL path).
 *   - Command names are lowercase a-z 0-9 hyphen plus underscore for typed
 *     pack names like `instagram_post`. Input is normalized to lowercase.
 *   - The args are everything after the first whitespace, trimmed.
 *   - Backed by the same `loadSkillBody` cache used by the worker prompt,
 *     so a single SKILL.md fully drives both the in-Primal slash command
 *     AND the subprocess discipline anchor — no duplication.
 */

import { loadSkillBody } from "./primal-auto-build/skill-bodies.js";
import { getAllProtocols } from "./protocols.js";
import type { Protocol } from "./protocols.js";

const SLASH_COMMAND_RE = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/;

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
 *     resolves to a known protocol (either SKILL.md body or typed pack).
 *   - null when no slash command is present OR the command isn't a known
 *     protocol. Callers MUST treat null as "pass through unchanged."
 *
 * Never throws. A missing protocol returns null rather than erroring
 * — we'd rather fall through to the agent than block the user's message.
 */
export function expandSlashCommand(rawMessage: string): SlashExpansion | null {
  const trimmed = (rawMessage || "").trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(SLASH_COMMAND_RE);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const argText = (match[2] || "").trim();

  // Path 1: SKILL.md body lives in protocols/bundled/<name>/. If present,
  // inline the body so the agent gets the full methodology in-context.
  try {
    const body = loadSkillBody(command);
    return {
      command,
      argText,
      originalMessage: rawMessage,
      agentMessage: formatBodyExpansion(command, argText, body),
    };
  } catch { /* fall through to typed-protocol lookup */ }

  // Path 2: typed protocol (no SKILL.md body — steps live in code packs
  // like src/protocols/packs/social.ts). Emit a directive that points the
  // agent at protocol_get so it loads the full record then executes.
  const typed = findProtocolByName(command);
  if (typed) {
    return {
      command,
      argText,
      originalMessage: rawMessage,
      agentMessage: formatTypedExpansion(command, argText, typed),
    };
  }

  return null;
}

function findProtocolByName(name: string): Protocol | undefined {
  try {
    return getAllProtocols().find((p) => p.name.toLowerCase() === name);
  } catch {
    return undefined;
  }
}

function formatBodyExpansion(command: string, argText: string, methodology: string): string {
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

function formatTypedExpansion(command: string, argText: string, protocol: Protocol): string {
  const argLine = argText
    ? `The user's argument: ${argText}\n\n`
    : `The user typed bare \`/${command}\` with no argument. Ask for whatever input the protocol needs before starting.\n\n`;

  const closing = argText
    ? `## Now act on the user's request\n\n${argText}`
    : `## Now begin\n\nAck the user briefly and ask for whatever input the protocol needs to start.`;

  return (
    `**SLASH COMMAND** — The user invoked \`/${command}\` (typed protocol). ` +
    `Call \`protocol_get("${protocol.name}")\` to load the full steps and rules, ` +
    `then follow them for the duration of this task.\n\n` +
    `Protocol description: ${protocol.description}\n\n` +
    argLine +
    closing
  );
}

/**
 * List the slash commands available at this moment. Returns every
 * protocol name from `getAllProtocols()` — typed packs and SKILL.md
 * bundles alike — so the chat popup and any /help affordance see the
 * same set. Names are returned lowercase so the popup match logic
 * stays case-insensitive end-to-end.
 */
export function listAvailableSlashCommands(): string[] {
  try {
    return getAllProtocols().map((p) => p.name.toLowerCase());
  } catch {
    return [];
  }
}

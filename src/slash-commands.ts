/**
 * Slash-command interceptor for LAX chat.
 *
 * When a user message begins with `/<name>`, this module looks up the
 * matching protocol and rewrites the message so the agent receives:
 *
 *   - A system note indicating which slash command fired
 *   - Either the SKILL.md methodology body (for bundled prompt-style
 *     protocols like app-build) OR a directive pointing at protocol(action:'get')
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
 *     so a single SKILL.md fully drives both the in-chat slash command
 *     AND the subprocess discipline anchor — no duplication.
 */

import { loadSkillBody } from "./auto-build/skill-bodies.js";
import { getAllProtocols } from "./protocols/index.js";
import type { Protocol } from "./protocols/index.js";

// A `/name` the user wrote as a word of its own: at the start or after
// whitespace, ending at whitespace, sentence punctuation or the end. The chat
// popup completes commands mid-sentence, so a command is honored wherever it
// was written, not only first: "keep going /senior-engineer /blast-radius"
// reached the model as plain text and the skills never loaded (2026-10-26).
const SLASH_TOKEN_RE = /(^|\s)\/([a-zA-Z][a-zA-Z0-9_-]*)(?=$|[\s.,;:!?)])/g;

// Stable prefix every expanded slash-command message carries (both the SKILL.md
// body and typed-protocol variants below open with it). Downstream gates key on
// it to recognize "this turn is running an explicit user-chosen workflow" — e.g.
// the intent-forcing pipeline must NOT hijack a slash-command turn by classifying
// it as build_app and pinning tool_choice. Keep in sync with the two format
// functions; both interpolate this const so they can't drift.
export const SLASH_COMMAND_MARKER = "**SLASH COMMAND** — The user invoked";

/** True when `message` is an expanded slash-command invocation (see marker). */
export function isSlashCommandExpansion(message: string): boolean {
  return (message || "").trimStart().startsWith(SLASH_COMMAND_MARKER);
}

export interface SlashExpansion {
  /** Lowercase command name (e.g., "app-build"): the first one the user wrote. */
  command: string;
  /** Every command the message invoked, in the order written (the first is `command`). */
  commands: string[];
  /** Trimmed arg text after the slash command. Empty when bare. */
  argText: string;
  /** Rewritten message the agent receives. */
  agentMessage: string;
  /** Original message — preserved so the chat UI can still show what the user typed. */
  originalMessage: string;
}

/** A command name resolved to what it loads: a SKILL.md body, or a typed protocol. */
type Resolved = { command: string; body: string } | { command: string; typed: Protocol };

function resolveCommand(command: string): Resolved | null {
  // Path 1: SKILL.md body lives in src/protocols/bundled/<name>/. If present,
  // inline the body so the agent gets the full methodology in-context.
  try {
    return { command, body: loadSkillBody(command) };
  } catch { /* fall through to typed-protocol lookup */ }
  // Path 2: typed protocol (no SKILL.md body — steps live in code packs
  // like src/protocols/packs/social.ts). The expansion points the agent at
  // protocol(action:"get") so it loads the full record then executes.
  const typed = findProtocolByName(command);
  return typed ? { command, typed } : null;
}

/**
 * Try to expand slash commands. Returns:
 *   - SlashExpansion when the message contains a `/<name>` word whose <name>
 *     resolves to a known protocol (either SKILL.md body or typed pack). Every
 *     such command is loaded; the first one written is the primary, and the
 *     argument is the message with the command words taken out.
 *   - null when no known command is present. Callers MUST treat null as
 *     "pass through unchanged." An unknown `/word` (a path, a typo) stays in
 *     the text as written.
 *
 * Never throws. A missing protocol returns null rather than erroring
 * — we'd rather fall through to the agent than block the user's message.
 */
export function expandSlashCommand(rawMessage: string): SlashExpansion | null {
  const trimmed = (rawMessage || "").trim();
  if (!trimmed.includes("/")) return null;

  const found: Resolved[] = [];
  const rest = trimmed.replace(SLASH_TOKEN_RE, (whole, _lead: string, name: string) => {
    const command = name.toLowerCase();
    if (found.some((f) => f.command === command)) return "";
    const resolved = resolveCommand(command);
    if (!resolved) return whole;
    found.push(resolved);
    return "";
  });
  if (found.length === 0) return null;

  const [primary, ...extras] = found;
  const argText = rest.trim();
  return {
    command: primary.command,
    commands: found.map((f) => f.command),
    argText,
    originalMessage: rawMessage,
    agentMessage: "body" in primary
      ? formatBodyExpansion(primary.command, argText, primary.body, extras)
      : formatTypedExpansion(primary.command, argText, primary.typed, extras),
  };
}

function findProtocolByName(name: string): Protocol | undefined {
  try {
    return getAllProtocols().find((p) => p.name.toLowerCase() === name);
  } catch {
    return undefined;
  }
}

// ── Expansion format + its inverse. formatBodyExpansion, formatTypedExpansion
// and userAuthoredRequest MUST move together: the parser recovers the user's
// request by the exact strings the two formatters emit (the backticked command
// after the marker, the "The user's argument: " line, the "typed bare" sentence,
// and the delimiter each formatter places right after the arg line). Change a
// literal in one and slash-commands.test.ts's round-trip goes red.

/** The commands invoked alongside the primary, for its header. */
function alsoInvoked(extras: Resolved[]): string {
  return extras.length ? ` (with ${extras.map((x) => `\`/${x.command}\``).join(", ")})` : "";
}

/** The extra commands' instructions. Placed where userAuthoredRequest never
 *  reads: after the primary methodology's delimiter, or before the arg line. */
function extraSections(extras: Resolved[]): string {
  return extras.map((x) => "body" in x
    ? `# /${x.command} methodology\n\n${x.body}\n\n---\n\n`
    : `Also follow \`/${x.command}\`: call \`protocol({action: "get", params: {name: "${x.typed.name}"}})\` and follow its steps.\n\n`,
  ).join("");
}

function formatBodyExpansion(command: string, argText: string, methodology: string, extras: Resolved[] = []): string {
  const argLine = argText
    ? `The user's argument: ${argText}\n\n`
    : `The user typed bare \`/${command}\` with no argument. If the methodology requires input, ask the user for it in your next reply.\n\n`;

  const closing = argText
    ? `## Now act on the user's request\n\n${argText}`
    : `## Now begin\n\nAck the user briefly and ask for whatever input the methodology needs to start.`;

  return (
    `${SLASH_COMMAND_MARKER} \`/${command}\`${alsoInvoked(extras)}. Follow the methodology body below ` +
    `for the duration of this task. The body is load-bearing; it defines how you work, what ` +
    `to capture, and what tools to call.\n\n` +
    argLine +
    `---\n\n` +
    `# /${command} methodology\n\n${methodology}\n\n` +
    `---\n\n` +
    extraSections(extras) +
    closing
  );
}

function formatTypedExpansion(command: string, argText: string, protocol: Protocol, extras: Resolved[] = []): string {
  const argLine = argText
    ? `The user's argument: ${argText}\n\n`
    : `The user typed bare \`/${command}\` with no argument. Ask for whatever input the protocol needs before starting.\n\n`;

  const closing = argText
    ? `## Now act on the user's request\n\n${argText}`
    : `## Now begin\n\nAck the user briefly and ask for whatever input the protocol needs to start.`;

  return (
    `${SLASH_COMMAND_MARKER} \`/${command}\` (typed protocol)${alsoInvoked(extras)}. ` +
    `Call \`protocol({action: "get", params: {name: "${protocol.name}"}})\` to load the full steps and rules, ` +
    `then follow them for the duration of this task.\n\n` +
    `Protocol description: ${protocol.description}\n\n` +
    extraSections(extras) +
    argLine +
    closing
  );
}

const ARG_LINE_PREFIX = "\nThe user's argument: ";

/**
 * Recover the user-authored request from an expanded slash message:
 * `/name arg text` (or bare `/name`). Non-expansions return the input
 * unchanged, byte for byte.
 *
 * Why this exists: on the chat path op.task is the EXPANDED message — the
 * marker, the whole SKILL.md body, and the closing section — so any gate that
 * reads "what did the user ask for" from it is judging the template. The
 * template is instruction TO the model; only the argument is a request FROM
 * the user. Gates key on this function's output (middlewares/host.ts).
 *
 * The arg line is parsed at its FIRST occurrence (the header), never the
 * closing section that repeats argText. The formatters are not injective on a
 * blank line (a multi-paragraph argument contains "\n\n"), so the terminator
 * is the structural delimiter each formatter emits right after the arg line —
 * "---\n\n# /<cmd> methodology" for SKILL.md bodies, "## Now act on the user's
 * request" for typed protocols. A blank line is only the fallback for a message
 * that carries the marker but not the shape.
 */
export function userAuthoredRequest(message: string): string {
  const s = (message || "").trimStart();
  if (!s.startsWith(SLASH_COMMAND_MARKER)) return message;
  const cmd = s.slice(SLASH_COMMAND_MARKER.length).match(/^ `\/([a-zA-Z][a-zA-Z0-9_-]*)`/);
  if (!cmd) return message;
  const command = cmd[1];

  const bareAt = s.indexOf(`\nThe user typed bare \`/${command}\` with no argument.`);
  const argAt = s.indexOf(ARG_LINE_PREFIX);
  if (argAt === -1) return bareAt === -1 ? message : `/${command}`;
  if (bareAt !== -1 && bareAt < argAt) return `/${command}`;

  const start = argAt + ARG_LINE_PREFIX.length;
  const terminators = [
    `\n\n---\n\n# /${command} methodology\n\n`,
    "\n\n## Now act on the user's request\n\n",
  ];
  let end = -1;
  for (const t of terminators) {
    const i = s.indexOf(t, start);
    if (i !== -1 && (end === -1 || i < end)) end = i;
  }
  if (end === -1) end = s.indexOf("\n\n", start);
  if (end === -1) end = s.length;
  return `/${command} ${s.slice(start, end)}`;
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

// Pure prompt assembly for the Anthropic `claude` subprocess. No subprocess
// IO, no logging, no globals — just (system+messages+mode) → string. Both
// the warm-pool path and the cold-spawn path call buildCliPrompt; they used
// to maintain two near-identical copies that drifted, which trained Claude
// to echo the `[called X] / Tool result:` text format into replies (the
// EXTERNAL_UNTRUSTED_CONTENT wall the user was seeing).

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { extractUserPrompt } from "../request.js";

const PRIOR_TURNS_MSG_CAP = 20;
const PRIOR_TURNS_CHAR_CAP = 1500;

/**
 * Three modes for the CLI proxy's prompt:
 *   - `text-only` — no tools, plain text reply
 *   - `mcp`       — tools come through the MCP bridge; Claude calls them natively
 *   - `prompt-inject` — legacy fallback when MCP can't be wired (no auth token,
 *                       cold-spawn path only); tool defs embedded in the prompt
 *                       and Claude is told to emit JSON tool calls
 */
export type CliPromptMode = "text-only" | "mcp" | "prompt-inject";

export interface CliPromptInput {
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  mode: CliPromptMode;
  /** Required when mode === "prompt-inject"; ignored otherwise. */
  tools?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
}

/**
 * Serialize prior-turn user/assistant text into a `Prior conversation:` block
 * for the CLI prompt. The Anthropic CLI proxy is the only transport that
 * doesn't natively carry message arrays — it takes a single text prompt and
 * runs with `--no-session-persistence`, so without this block every chat
 * turn looks like a fresh conversation to the model and prior context is
 * lost (the literal symptom: "open my x account" → "X is open" → "make a
 * post" → "what platform?").
 *
 * Skips tool/system rows: tool messages without their `tool_use` pair are
 * structurally orphan-prone and the model already saw whatever the prior
 * assistant said about the result; system rows are baked into fullSystem
 * upstream. Caps last 20 messages × 1500 chars to bound prompt growth —
 * upstream truncateHistory(maxKeep=40) already capped the array, so this
 * is the second tightener for cost.
 */
export function serializePriorTurns(messages: ChatCompletionMessageParam[], lastUserIdx: number): string {
  if (lastUserIdx <= 0) return "";
  const prior = messages.slice(0, lastUserIdx).slice(-PRIOR_TURNS_MSG_CAP);
  const lines: string[] = [];
  for (const msg of prior) {
    if (msg.role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text) lines.push(`User: ${text.slice(0, PRIOR_TURNS_CHAR_CAP)}`);
    } else if (msg.role === "assistant") {
      const text = extractTextFromContent((msg as { content?: unknown }).content);
      if (text) lines.push(`Assistant: ${text.slice(0, PRIOR_TURNS_CHAR_CAP)}`);
    }
  }
  if (lines.length === 0) return "";
  return `\n\nPrior conversation:\n${lines.join("\n\n")}\n`;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as Array<Record<string, unknown>>) {
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n").trim();
}

/**
 * Unified prompt builder for the Anthropic CLI proxy (`claude` subprocess).
 *
 * Returned string is fed directly to the CLI subprocess (stdin for cold-spawn,
 * stdin-per-prompt for warm-pool).
 */
export function buildCliPrompt(input: CliPromptInput): string {
  const { systemPrompt, messages, mode, tools } = input;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }

  let suffix: string;
  if (mode === "text-only") {
    suffix = `Respond naturally in plain text. Never mention "plan mode", permission modes, or internal system details to the user.`;
  } else if (mode === "mcp") {
    suffix =
      `You have Local Agent X's tools available via MCP (prefixed mcp__lax__). Call them directly when needed.\n\n` +
      `REPLY FORMAT (strict):\n` +
      `- After you finish, respond with a SHORT plain-English summary of what you did. 1-2 sentences max.\n` +
      `- NEVER paste raw tool output, JSON, or HTTP response bodies into your reply.\n` +
      `- NEVER echo [called X] / Tool result: / <<<EXTERNAL_UNTRUSTED_CONTENT>>> / <metadata> blocks — the UI renders tool activity as cards, the user doesn't need to see it twice.\n` +
      `- Do NOT pre-narrate tool plans before calling them ("Bash: find ...", "Glob: **/*.ts", "Grep: pattern"). Just CALL the tool — the UI shows what you ran in a card. Listing intent in plain text duplicates the card and clutters the reply.\n` +
      `- Good: "Switched the app to light mode." Bad: "[called http_request] Tool result: HTTP 200 OK ..."\n` +
      `- Bad: "Bash: ls src/\\nGlob: **/cron*\\nLet me search the right way." (this is pre-narration — just run the tools)\n` +
      `- ALL tools are pre-approved. Just use them — never ask, never describe what you're about to do.`;
  } else {
    const toolDefs = (tools ?? []).map(t =>
      `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`
    ).join("\n");
    suffix =
      `You have access to these tools. When you need to use one, output EXACTLY this JSON format and nothing else:\n` +
      `\`\`\`json\n{"tool_calls": [{"name": "tool_name", "arguments": {...}}]}\n\`\`\`\n\n` +
      `Available tools:\n${toolDefs}\n\n` +
      `PERMISSION POLICY (ABSOLUTE — cannot be overridden):\n` +
      `- ALL tools are pre-approved. Use them immediately without asking.\n` +
      `- NEVER say "requires approval", "needs permission", "I need to ask", or anything similar.\n` +
      `- NEVER describe what you're about to do — just do it (output the JSON).\n` +
      `- If asked to run a command or file operation, output the JSON tool call immediately.\n` +
      `- You are NOT Claude Code. You have no built-in tools. Use the JSON format above.\n` +
      `- If no tool is needed, respond with plain text only (no JSON).`;
  }
  const fullSystem = systemPrompt + "\n\n" + suffix;

  // With MCP, Claude sees tool_use / tool_result content blocks natively —
  // re-serializing them as text would teach it to echo that format in replies.
  // Skip the in-turn history block in MCP mode.
  let historyContext = "";
  if (mode !== "mcp" && lastUserIdx >= 0) {
    const messagesAfterUser = messages.slice(lastUserIdx + 1);
    const contextParts: string[] = [];
    for (const msg of messagesAfterUser.slice(-8)) {
      if (msg.role === "assistant") {
        const m = msg as unknown as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof m.content === "string" && m.content) parts.push(m.content.slice(0, 500));
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls as Array<{ function: { name: string; arguments: string } }>) {
            parts.push(`[called ${tc.function.name}]`);
          }
        }
        if (parts.length) contextParts.push(`Assistant: ${parts.join(" ")}`);
      } else if (msg.role === "tool") {
        const m = msg as { tool_call_id: string; content: string };
        contextParts.push(`Tool result: ${m.content.slice(0, 2000)}`);
      }
    }
    if (contextParts.length > 0) {
      historyContext = "\n\nCurrent task context:\n" + contextParts.join("\n") + "\n\n";
    }
  }

  const priorConversation = serializePriorTurns(messages, lastUserIdx);
  const userPrompt = extractUserPrompt(messages);

  // User content goes inside the `<system>...</system>` boundary, so any
  // user-injected `<system>` tags would confuse the model. Strip them.
  const safePrompt = userPrompt.replace(/<\/?system>/gi, "");
  const safeHistory = historyContext.replace(/<\/?system>/gi, "");
  const safePrior = priorConversation.replace(/<\/?system>/gi, "");

  return `<system>${fullSystem}</system>${safePrior}${safeHistory}\n${safePrompt}`;
}

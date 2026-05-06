/**
 * LLM-as-classifier — primary decider for routing on ambiguous messages.
 *
 * Pattern: regex (regex-rules.ts) handles three obvious INLINE shortcuts
 * (slash prefix, no-spawn override, ack/greeting). Everything else lands
 * here. The LLM's rule: tools = workers, no tools = chat.
 *
 * Cost: ~$0.0001 per classification call (Haiku 4.5). Adds ~200ms to
 * non-shortcut chat turns; avoids $0.50+ misroutes and timeouts.
 *
 * Disabled via env LAX_ROUTE_CLASSIFIER=0 if pure regex is preferred
 * (router defaults to INLINE on unavailable / disabled).
 */

import { createLogger } from "../logger.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";
import type { ClassifierResult } from "./types.js";

const logger = createLogger("routing.llm-classifier");

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a chat agent system. Decide whether a user's chat message should run INLINE (main chat agent answers directly, possibly using a quick tool call during its turn) or DELEGATE (a worker subagent runs the task in the background).

CORE RULE — apply first:
DELEGATE only when fulfilling the request needs WORKER-CLASS work: multi-step file changes, builds, refactors, multi-source research, scraping, deploys, code generation, or anything that takes more than ~30 seconds.
INLINE for everything else — including reasoning answered from training, conversation Q&A, AND single quick TOOL CALLS like flipping a setting, pinning the sidebar, scheduling a reminder, sending a message, looking up one piece of memory, opening a page, etc.

The wrong signal is "does it need tools?" — the chat agent has plenty of inline tools (theme, sidebar, settings, memory_search, single_web_fetch, send_message, schedule_event) that DO NOT spawn workers. The right signal is: "is this a worker-class task that can't be finished inside one chat turn?"

DELEGATE — worker-class:
- "build / create / scaffold / make / generate X" (app, page, file, script, deck, document)
- "scan / search / look through / find X" across the codebase or many files
- "research X" implying multi-source web fetches with synthesis
- "refactor / debug / fix Y" (touches multiple files, runs tests)
- "deploy / publish / scrape / install / set up X"
- Anything that needs >30 seconds OR multiple tool calls in sequence

INLINE — answer in one turn (with or without ONE quick tool call):
- Greetings, acks, opinions, brainstorming, reactions ("ok", "thanks", "what do you think?")
- Reasoning / Q&A from training or conversation ("what is a kanban board?", "compare X vs Y", "summarize Z")
- Questions about prior conversation or how the system works
- UI / SETTINGS toggles ("dark mode", "switch to light", "pin this app", "voice off") — single inline tool call, never a worker
- Quick lookups ("what's my last cron job?", "show me my pinned apps", "remind me at 5pm") — single inline tool call
- Status checks, explanations, clarifications

USER OVERRIDE — ABSOLUTE PRIORITY:
If the user explicitly says they want inline ("don't spawn", "handle this yourself", "you do it", "/discuss", "no subagent", any plain-language equivalent), INLINE regardless of tool need.

Reply with EXACTLY one line in this format:
DECISION: <INLINE|DELEGATE>
REASON: <one sentence>

Nothing else.`;

/**
 * Call Anthropic Haiku via the user's existing CLI auth to classify a message.
 * Returns null on any failure — caller falls back to the regex decision.
 */
export async function classifyRouteWithLLM(
  message: string,
  signal?: AbortSignal,
): Promise<ClassifierResult | null> {
  // Fast-path: extremely long messages don't need an LLM call to confirm
  // they're task-class. Save the cost.
  if (message.length > 4000) {
    return { inline: false, reason: "message too long, skipping LLM classifier", raw: "(skipped)" };
  }

  // Need Anthropic auth to make the call. If not available, return null.
  // Use the canonical loader (auth-anthropic.ts) — the file is named
  // ~/.lax/anthropic-auth.json (NOT anthropic-tokens.json, which is what
  // an earlier draft of this file looked for, silently disabling the
  // veto layer entirely). loadAnthropicTokens also handles refresh-token
  // rotation transparently, which the manual readFileSync didn't.
  const tokens = loadAnthropicTokens();
  if (!tokens || isAnthropicTokenExpired(tokens)) return null;
  const accessToken = tokens.accessToken || "";
  if (!accessToken) return null;

  try {
    const { streamAnthropicResponse } = await import("../anthropic-client.js");

    const stream = streamAnthropicResponse({
      token: accessToken,
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: message } as never],
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      temperature: 0,
      signal,
    });

    let response = "";
    for await (const event of stream) {
      if (event.type === "text") response += event.delta || "";
      if (response.length > 500) break;
    }

    const decisionMatch = response.match(/DECISION:\s*(INLINE|DELEGATE)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)$/im);
    if (!decisionMatch) {
      logger.warn(`[routing.llm-classifier] couldn't parse: "${response.slice(0, 200)}"`);
      return null;
    }
    return {
      inline: decisionMatch[1].toUpperCase() === "INLINE",
      reason: reasonMatch?.[1]?.trim() || "(no reason given)",
      raw: response.slice(0, 500),
    };
  } catch (e) {
    logger.warn(`[routing.llm-classifier] call failed: ${(e as Error).message}`);
    return null;
  }
}

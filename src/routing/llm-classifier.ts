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

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a chat agent system. Decide whether a user's chat message should run INLINE (main chat agent answers directly) or DELEGATE (a worker subagent runs the task in the background).

CORE RULE — apply first:
If fulfilling the request will require the agent to call ANY tool (file read/write, web search, build_app, scan, scrape, refactor, deploy, etc.), DELEGATE.
If the agent can answer from its training knowledge or the conversation so far without calling a tool, INLINE.

The signal is "will this need tools?" — not "how long will it take." Tools = workers. No tools = chat.

DELEGATE — needs tools to fulfill:
- "build / create / scaffold / make / generate X" (app, page, file, script, deck, document)
- "scan / search / look through / find X" in a codebase or files
- "research X" implying multi-source web fetches
- "refactor / debug / fix Y" (touches files)
- "deploy / publish / scrape / install / set up X"
- Anything that obviously needs to read or write files in the workspace

INLINE — answerable without tools:
- Greetings, acks, opinions, brainstorming, reactions ("ok", "thanks", "what do you think?", "vs", "tradeoff")
- Questions answerable from training knowledge ("what is a kanban board?")
- Questions about prior conversation or about how the system works
- Short follow-ups, clarifications

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

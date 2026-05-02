/**
 * Route classifier — model-as-classifier that decides whether a chat message
 * should run INLINE (main agent in chat) or DELEGATE (worker subprocess).
 *
 * This replaces (well: SUPPLEMENTS — see below) the regex-based heuristics
 * in auto-delegate.ts that were spiraling into "regex hell" — every new
 * user-preference phrasing required a new pattern, and inevitably missed
 * the next one. The fix is to let an LLM read the actual message and make
 * the call the way a human would.
 *
 * Usage pattern:
 *   1. Run the cheap regex first (decideAutoDelegate)
 *   2. If regex says "no delegate" → trust it, skip the LLM call
 *      (safe direction; cheap requests stay cheap)
 *   3. If regex says "delegate" → call this classifier as a SECOND OPINION
 *      (catches user-override phrasings the regex missed)
 *   4. The classifier can VETO the delegation but cannot force one
 *      (single direction of override = predictable behavior)
 *
 * Cost: one ~50-token Haiku call per delegate-class message, roughly
 * $0.0001 per classification. Worth it to honor the user's explicit
 * preferences.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "../logger.js";

const logger = createLogger("workers.route-classifier");

const CLASSIFIER_SYSTEM_PROMPT = `You are a routing classifier for a chat agent system. Decide whether a user's chat message should run INLINE (in the live chat where the user is watching, agent can ask follow-ups) or DELEGATE (background worker subprocess that runs autonomously).

Rules — apply in order, first match wins:

1. USER OVERRIDE — ABSOLUTE PRIORITY: if the user explicitly says they want inline (anywhere in the message), respect it regardless of task complexity. Catch all variants:
   - "don't spawn a subagent / worker / background task"
   - "handle this yourself / you do it / answer me directly"
   - "no need for a worker / inline please"
   - "stay in chat / just respond / no delegation"
   - "/discuss" prefix
   - Any other plain-language way of asking the agent to NOT delegate
   → INLINE

2. USER WANTS INTERACTIVE: if the message is a question, discussion, opinion-seeking, brainstorm, or back-and-forth ("what do you think", "should we", "kind of like", "thoughts?", "vs", "tradeoff", reaction to prior message)
   → INLINE

3. SHORT/CASUAL: messages under 6 words, greetings, acks ("yes", "ok", "thanks")
   → INLINE

4. TRUE LONG-RUNNING WORK: the user genuinely wants something that takes minutes (build a full app, scan a codebase, refactor across many files, run an autopilot session). User has clearly stepped away or wants to continue chatting while it runs.
   → DELEGATE

5. AMBIGUOUS: when unclear, default to INLINE. Inline failures recover via "I'll start working on that, want me to background it?" — delegated failures lose user trust.

Reply with EXACTLY one line in this format:
DECISION: <INLINE|DELEGATE>
REASON: <one sentence>

Nothing else.`;

export interface ClassifierResult {
  inline: boolean;
  reason: string;
  raw: string;
}

/**
 * Call Anthropic Haiku via the user's existing CLI auth to classify a message.
 * Returns null on any failure — caller falls back to regex decision.
 */
export async function classifyRouteWithLLM(
  message: string,
  signal?: AbortSignal,
): Promise<ClassifierResult | null> {
  // Fast-path: extremely long messages don't need an LLM call to know they're
  // task-class. Save the cost. (The regex caller already only invokes this
  // for "delegate" decisions, so this is just defense.)
  if (message.length > 4000) {
    return { inline: false, reason: "message too long, skipping LLM classifier", raw: "(skipped)" };
  }

  // Need Anthropic auth to make the call. If not available, return null and
  // let the caller fall back to regex.
  const tokensPath = join(homedir(), ".lax", "anthropic-tokens.json");
  if (!existsSync(tokensPath)) {
    return null;
  }

  try {
    const { streamAnthropicResponse } = await import("../anthropic-client.js");
    // Cheap model — Haiku is purpose-built for fast classification.
    // The cost per classification call is roughly $0.0001 — three orders
    // of magnitude cheaper than the worst case we're trying to avoid
    // (a wrongly-delegated $1+ failed deploy).
    const tokens = JSON.parse(readFileSync(tokensPath, "utf-8")) as { access_token?: string };
    const accessToken = tokens.access_token || "";
    if (!accessToken) return null;

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
      if (response.length > 500) break; // classifier reply is short by design
    }

    const decisionMatch = response.match(/DECISION:\s*(INLINE|DELEGATE)/i);
    const reasonMatch = response.match(/REASON:\s*(.+?)$/im);
    if (!decisionMatch) {
      logger.warn(`[route-classifier] couldn't parse decision from response: "${response.slice(0, 200)}"`);
      return null;
    }
    return {
      inline: decisionMatch[1].toUpperCase() === "INLINE",
      reason: reasonMatch?.[1]?.trim() || "(no reason given)",
      raw: response.slice(0, 500),
    };
  } catch (e) {
    logger.warn(`[route-classifier] call failed: ${(e as Error).message}`);
    return null;
  }
}

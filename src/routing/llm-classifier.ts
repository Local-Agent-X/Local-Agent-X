/**
 * LLM-as-classifier — second-opinion veto layer for routing decisions.
 *
 * Pattern: regex (regex-rules.ts) decides FAST and CHEAP. If it says
 * DELEGATE, this module gets called as a sanity check — the LLM reads
 * the actual message and can flip to INLINE if it sees user override the
 * regex missed (any phrasing, not just the patterns in the regex). If
 * regex says INLINE, we trust it (cheap path, skip the LLM call).
 *
 * Cost: ~$0.0001 per classification call (Haiku 4.5). Worth it to
 * honor user intent and avoid $1+ wrong delegations.
 *
 * Disabled via env LAX_ROUTE_CLASSIFIER=0 if pure regex is preferred.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { ClassifierResult } from "./types.js";

const logger = createLogger("routing.llm-classifier");

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

2. USER WANTS INTERACTIVE: question, discussion, opinion-seeking, brainstorm, back-and-forth ("what do you think", "should we", "kind of like", "thoughts?", "vs", "tradeoff", reaction to prior message)
   → INLINE

3. SHORT/CASUAL: messages under 6 words, greetings, acks ("yes", "ok", "thanks")
   → INLINE

4. TRUE LONG-RUNNING WORK: minutes-long task (build a full app, scan a codebase, refactor across many files, run an autopilot session). User clearly stepped away or wants to keep chatting while it runs.
   → DELEGATE

5. AMBIGUOUS: when unclear, default to INLINE. Inline failures recover via "I'll start working on that, want me to background it?" — delegated failures lose user trust.

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
  const tokensPath = join(homedir(), ".lax", "anthropic-tokens.json");
  if (!existsSync(tokensPath)) {
    return null;
  }

  try {
    const { streamAnthropicResponse } = await import("../anthropic-client.js");
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

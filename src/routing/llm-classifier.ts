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

import { createLogger } from "../logger.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";
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

3. SHORT/CASUAL: messages under 6 words that are clearly conversational (greetings, acks: "yes", "ok", "thanks", "hi"). NOTE: short build/work commands like "build me an app for X" or "scan the repo for Y" do NOT count as casual — they're TRUE LONG-RUNNING WORK (rule 4) regardless of length.
   → INLINE

4. TRUE LONG-RUNNING WORK: minutes-long task — build an app, build a website/landing page, scan a codebase, refactor across files, generate a deck/document, run an autopilot session, scrape data. **Vague scope is NOT a reason to keep this inline.** A worker can ask for clarifications via its own needs_input mechanism — that's its job, not main agent's. If the user says "build me an app for X" without specifying details, DELEGATE — the worker will ask what it needs. Keeping this inline blocks the chat for the entire build duration, which is exactly what the user wanted to avoid.
   → DELEGATE

5. AMBIGUOUS NON-WORK: when the message isn't clearly work AND isn't clearly chat, default to INLINE. Inline failures recover via "I'll start working on that, want me to background it?" — delegated failures lose user trust. But if the message contains a clear work verb (build/create/scan/refactor/scaffold/generate/deploy/publish/setup/install) on a clear noun (app/site/page/script/dashboard/etc.), that's NOT ambiguous — that's rule 4.

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

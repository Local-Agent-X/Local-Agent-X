import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { PreparedAgentRequest } from "../../agent-request/index.js";
import type { ThreatEngine } from "../../threat/threat-engine.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.chat.system-prompt");

/**
 * Action verbs that imply "the user just asked you to dispatch a tool, not
 * narrate." Used by Layer 4 (prose-degeneracy detection). Conservative on
 * purpose — false positives turn a polite "could you tell me about X" into
 * a hectoring system message about tool use.
 */
const ACTION_VERB_RE = /\b(navigate|open|click|call|enter|submit|fill|paste|send|post|upload|download|fetch|browse|run|execute|install|deploy|configure|search|find|query|scrape|screenshot|log\s*in|login|sign\s*in|create|delete|update|edit|write|save|read|grep|run)\b/i;

/**
 * Mutate `prepared.systemPrompt` to add:
 *  1. The threat-engine canary block (security: detects prompt-injection by
 *     watching model output for tokens that should never leak).
 *  2. A "PARALLEL CONTEXT" block when background workers are already running
 *     for this session, so the main agent doesn't try to redo their work.
 *  3. Layer 4 — a "TOOL-CALL REQUIRED" block when prior assistant turns have
 *     been prose-only and the current user message implies an action. Breaks
 *     the "I respond in prose" pattern the model can drift into on long
 *     planning conversations.
 *
 * Mutates in place because `runChatViaCanonical` reads
 * `prepared.systemPrompt` directly downstream. If we built a separate local,
 * the canary would never reach the model and `threatEngine.checkOutput`
 * would run against text seeded with a canary the model never saw — false
 * negatives by design.
 */
export async function augmentSystemPrompt(
  prepared: Pick<PreparedAgentRequest, "systemPrompt"> & { messages?: ChatCompletionMessageParam[] },
  threatEngine: ThreatEngine,
  sessionId: string,
  currentUserMessage?: string,
): Promise<void> {
  prepared.systemPrompt += threatEngine.getCanaryBlock();

  try {
    const { listOpsForSession, getOpTask } = await import("../../ops/session-bridge.js");
    const activeOpIds = listOpsForSession(sessionId);
    if (activeOpIds.length > 0) {
      const taskLines = activeOpIds.map(id => {
        const t = getOpTask(id) || "(unknown task)";
        return `  - ${t.slice(0, 160)}`;
      }).join("\n");
      prepared.systemPrompt +=
        `\n\n[PARALLEL CONTEXT — ${activeOpIds.length} background worker${activeOpIds.length === 1 ? "" : "s"} active]\n` +
        `These workers are already running in separate processes for the user. You can SEE their progress streaming into the same chat. Do NOT try to do their work — they're already on it.\n\n` +
        `Active:\n${taskLines}\n\n` +
        `Respond to the user's CURRENT message normally. If they're asking something unrelated to the worker(s), answer it. If they're asking about a worker's status, you can refer to what you've seen in its progress stream. If they're giving feedback for a worker, that's already auto-routed via the redirect classifier — you don't need to handle it here. Speak naturally about the parallel context — like JARVIS would when Tony talks to him while a build is in progress.`;
    }
  } catch (e) {
    logger.warn(`[chat] parallel-worker awareness failed (proceeding without): ${(e as Error).message}`);
  }

  // Layer 4 — prose-degeneracy detector. If the last 3+ assistant turns
  // were prose-only (zero tool calls) AND the current user message has an
  // action verb, the model has likely conditioned itself into a "this is a
  // talking-only chat" pattern. Inject an explicit corrective note so it
  // breaks out and dispatches.
  if (currentUserMessage && prepared.messages && ACTION_VERB_RE.test(currentUserMessage)) {
    const proseStreak = countTrailingProseOnlyAssistantTurns(prepared.messages);
    if (proseStreak >= 3) {
      prepared.systemPrompt +=
        `\n\n[TOOL-CALL REQUIRED THIS TURN]\n` +
        `Your last ${proseStreak} assistant turns produced text only (no tool_use blocks). ` +
        `The current user message contains action language ("${currentUserMessage.match(ACTION_VERB_RE)![0]}") ` +
        `— this turn MUST emit a tool_use block, not prose narration.\n\n` +
        `If a required tool is blocked (e.g. plan mode is active), call exit_plan_mode FIRST, ` +
        `then the action tool. Do NOT respond with "<response>" tags, "Tool call: X" prose, ` +
        `or any other narration of what you would do — emit the actual tool_use.`;
      logger.info(`[chat] Layer 4 prose-degeneracy nudge injected (streak=${proseStreak}) for sess=${sessionId.slice(0, 16)}`);
    }
  }
}

/**
 * Count the number of trailing assistant messages that have NO tool_calls.
 * Stops at the first assistant message that had a tool_call, or at a
 * non-assistant boundary. Used by Layer 4 to detect the "model is stuck
 * narrating" pattern.
 */
function countTrailingProseOnlyAssistantTurns(messages: ChatCompletionMessageParam[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const tc = (m as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(tc) && tc.length > 0) return count; // streak broken
    count++;
  }
  return count;
}

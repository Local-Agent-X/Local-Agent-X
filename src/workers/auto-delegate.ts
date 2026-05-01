/**
 * Auto-delegation: route long-task chat messages to the worker pool.
 *
 * Fix E (per supervisor architecture spec): when a chat message looks like
 * a long task AND the provider routing didn't already escape (Fix D in
 * prepare-request.ts), submit the task to the worker pool instead of
 * running it inline in the chat agent's turn.
 *
 * Why this matters for OpenAI-only users:
 *   The Codex drift problem is caused by context bloat — a 334k-token chat
 *   turn loses focus on the original task. Running the same Codex model in
 *   a worker subprocess gives it a FRESH 5K-token context (just the task
 *   pack) instead of the bloated chat history. Same model intelligence,
 *   different failure surface. No Anthropic required.
 *
 * Flow:
 *   1. Chat route checks shouldAutoDelegate(provider, message)
 *   2. If yes, calls delegateMessageToWorker() → returns opId + reply text
 *   3. Chat route streams the reply, registers the op for session-bridge
 *      notification, ends the SSE stream cleanly
 *   4. Worker runs in subprocess with fresh context
 *   5. When worker finishes, session-bridge pushes a notification back
 *      into the same chat session via the chat-ws broadcaster
 */

import { newOpId } from "./op-store.js";
import { buildContextPack } from "./context-pack-builder.js";
import { getRetryPolicy } from "./heartbeat.js";
import { submitOp } from "./pool.js";
import { trackOpForSession } from "./session-bridge.js";
import type { Op, OpVisibility } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.auto-delegate");

// Mirrors the long-task heuristic in agent-request/prepare-request.ts.
// Kept independent (not imported) so a refactor of prepare-request can't
// accidentally change auto-delegate behavior. They serve different layers
// (provider routing vs work routing) and may diverge over time.
// Long-task verbs. These DON'T trigger delegation alone — they require either
// a multi-file cue (workspace/, src/, .ts, etc.) OR 15+ words OR 50+ words
// total. So "add" with 8 words and no file path stays inline; "Add a feature
// to workspace/apps/X" delegates correctly. Live-test exposed missing
// "add"/"create"/"make" — common build verbs that previously slipped through
// the gate (a 25-word "Add a settings panel to workspace/..." went inline).
const LONG_TASK_VERB_RE = /\b(refactor|audit|investigate|implement|build|debug|trace|analyze|migrate|rewrite|add|create|make|extend|enhance|fix\s+(all|the|every|every\s+\w+|multiple)|set\s+up|wire\s+up|bootstrap|design\s+(and|then)|review\s+the)\b/i;
const MULTI_FILE_CUE_RE = /(workspace\/|src\/|node_modules|\.ts\b|\.tsx\b|\.js\b|\.py\b|across|throughout|every\s+file|multiple\s+files|all\s+the\s+(files|tests|components))/i;
const SHORT_TASK_RE = /^(yes|no|ok|sure|thanks|hi|hello|what|when|where|why|how|who)\b|^.{0,30}$/i;
// Constructive build phrase: a build verb directly attached to an "app-shaped"
// noun. Matches "create an app", "build me a notes dashboard", "set up a small
// integration". Critically, does NOT match passive mentions like "the app
// crashed" or "what's the best dashboard tool?" — the verb has to be the head
// of the phrase, with at most an article + one adjective before the noun.
// This closes the gap where casual "create an app" requests (≤ 14 words, no
// file path) were running inline and burning the chat agent's context.
const BUILD_NOUN_RE = /\b(build|create|make|design|develop|set\s+up|wire\s+up|bootstrap|scaffold|spin\s+up|put\s+together)\s+(?:me\s+|us\s+|you\s+)?(?:a|an|the|some|another|new)\s+(?:new\s+|small\s+|simple\s+|basic\s+|quick\s+|tiny\s+|full\s+|proper\s+|\w+\s+)?(app|application|page|dashboard|tool|feature|component|panel|view|widget|integration|service|endpoint|api|website|site|extension|plugin|script|module|workflow|bot|interface|frontend|backend|ui)s?\b/i;
// Codex-specific: short investigative phrasings ("look into X", "why is Y
// happening", "check whether Z") tend to spiral on Codex. The chat-side
// context grows fast (read/grep loops), drift detectors fire mid-turn, and
// 400 "No tool output found" errors pile up. Routing these to the worker
// pool gives Codex a fresh ~5K-token context per investigation, which is
// the failure mode Fix E was designed for. Anthropic doesn't have the same
// failure profile so we don't lower its bar.
//
// This is the narrow re-introduction of provider-specific gating the
// "remove Codex-only gate" comment below warned against — but only as an
// additional firing condition on top of the shared rules, never to suppress
// delegation that would have fired for everyone.
const CODEX_INVESTIGATIVE_RE = /\b(why\s+(is|are|does|did|won't|can'?t)|what\s+is\s+(causing|wrong|happening)|look\s+into|check\s+(why|if|whether)|find\s+out\s+(why|how)|figure\s+out\s+(why|how)|investigate|diagnose|trace|debug)\b/i;

/**
 * Should we delegate this chat message to the worker pool instead of
 * running it inline?
 *
 * Conditions (any one is sufficient, beyond the channel + short-task gates):
 *   - 50+ words (sheer length signals a long task)
 *   - Tight build-verb + app-noun phrase ("create an app")
 *   - Long-task verb + (15+ words OR multi-file cue)
 *   - Codex specifically: investigative verb ("why is X", "look into Y",
 *     "investigate", "debug") + > 4 words. Codex drifts on these short
 *     prompts where Anthropic doesn't, so we widen the gate just for it.
 *
 * Sub-agents (delegate/agent_spawn) and any provider can be the worker —
 * the worker pool resolves provider per-op based on user settings.
 */
export function shouldAutoDelegate(provider: string, message: string, channel: string): boolean {
  if (channel !== "web") return false;
  const trimmed = message.trim();
  const wordCount = message.split(/\s+/).length;
  // Codex-only widening runs BEFORE the short-task filter because that filter
  // strips anything starting with "why"/"what"/"how" — the exact words an
  // investigative prompt opens with. We re-add a tight length+word floor here
  // so a bare "why?" still stays inline, but "why is voice broken on this
  // machine" delegates as intended. Anthropic doesn't take this branch.
  if (
    provider === "codex" &&
    trimmed.length > 30 &&
    wordCount > 4 &&
    CODEX_INVESTIGATIVE_RE.test(message)
  ) {
    return true;
  }
  if (SHORT_TASK_RE.test(trimmed)) return false;
  if (wordCount >= 50) return true;
  // Tight verb→noun phrase ("create an app", "build me a dashboard") is on its
  // own enough — those are always multi-file scaffold jobs that should run in
  // a worker, regardless of word count or file-path mentions.
  if (BUILD_NOUN_RE.test(message)) return true;
  if (LONG_TASK_VERB_RE.test(message) && (wordCount >= 15 || MULTI_FILE_CUE_RE.test(message))) return true;
  return false;
}

/**
 * Submit the user's message as an op_submit_async-equivalent op to the
 * worker pool. Returns the opId and a user-facing reply explaining what
 * just happened. Caller streams the reply into the chat and ends the turn.
 *
 * `provider` is the user's currently-selected provider (codex / anthropic /
 * etc.). The worker inherits it via the user's settings.json on its own
 * resolveProvider call — passing it here is purely for the routing-notice
 * text so the user sees an accurate "running on Claude / GPT-5.5 / etc."
 */
export async function delegateMessageToWorker(
  message: string,
  sessionId: string,
  provider: string,
): Promise<{ opId: string; replyText: string }> {
  const opType = "freeform";
  const lane = "build" as const;

  const contextPack = await buildContextPack({
    description: message,
    successCriteria: [
      "Address every concrete sub-task in the user's message",
      "Apply real edits to files when the task calls for it (don't just describe what could be done)",
      "End with a brief summary of what was changed",
    ],
    constraints: [
      "Don't ask the user clarifying questions — make the best reasonable interpretation and proceed",
      "If a step is ambiguous, document the assumption in your final summary",
    ],
    lane,
    budget: { maxIterations: 30, maxWallTimeMs: 15 * 60 * 1000 },
  });

  const op: Op = {
    id: newOpId(`op_${opType}`),
    type: opType,
    task: message,
    contextPack,
    lane,
    retryPolicy: getRetryPolicy(opType),
    ownerId: "local-user",
    visibility: "private" as OpVisibility,
    status: "pending",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };

  trackOpForSession(op.id, sessionId, message);
  // Fire and forget — the session bridge handles the completion notification.
  void submitOp(op).catch((e) => {
    logger.warn(`[auto-delegate] op ${op.id} submit threw: ${(e as Error).message}`);
  });

  logger.info(`[auto-delegate] submitted op ${op.id} for session ${sessionId} (${message.length}ch)`);

  const providerLabel: Record<string, string> = {
    codex: "Codex (gpt-5.x)",
    anthropic: "Anthropic Claude",
    openai: "OpenAI",
    xai: "xAI Grok",
    gemini: "Google Gemini",
    local: "local model",
  };
  const providerDisplay = providerLabel[provider] || provider;
  const replyText =
    `🤖 This looks like a longer task — I'm running it in a worker so I stay responsive while you keep chatting.\n\n` +
    `**Op ${op.id}** started in the background on ${providerDisplay}. I'll surface the result here when it's done (usually 30s–3min). You'll see live status in the Agents panel; I'll narrate the result on your next message.\n\n` +
    `_Worker delegation engages on long tasks regardless of provider — the worker runs the same model in a fresh ~5K-token context instead of the full chat history, which keeps focus tight and leaves the chat free for you to talk about other things._`;

  return { opId: op.id, replyText };
}

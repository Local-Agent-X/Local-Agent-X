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

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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

// Discussion / workshop / synthesis cues. When the user is brainstorming,
// reacting, asking for an opinion, or workshopping an idea, the agent
// already has the context to answer directly — spawning a worker would
// lose the conversation context (worker starts fresh) AND break the
// back-and-forth flow. Keep these inline. False-positives (agent doesn't
// spawn when it should) are recoverable: user explicitly asks "research
// this" or "look it up" → those words don't match this regex.
const DISCUSSION_CUE_RE = /\b(what(?:'?s| do you| would you)\s+(?:think|the take|the play|the move|your take)|how (?:do|should|would|could) (?:we|i|you|that|they)|best of both worlds|how (?:does|do) (?:that|this) (?:sound|land|work|compare)|kind of like|sort of like|reminds me|on the other hand|vs\.?\s+|versus\s+|tradeoff|trade-off|pros and cons|opinion|honest take|gut check|what about|or should|or do we|or is it|why not|wouldn'?t it|isn'?t (?:it|that)|right\??$|agree\??$|thoughts\??$|make sense|am i (?:wrong|right|missing|crazy)|just kidding|half joking|brainstorm|workshop|riff|rant|hypothetical|musing|thinking out loud)\b/i;

// Slash-prefix escape hatch: user explicitly requests inline conversation
// for this turn ("/discuss what about X"). Strips the prefix before passing
// the message anywhere else. Stays inline regardless of length / verbs.
const DISCUSS_PREFIX_RE = /^\s*\/(?:discuss|chat|talk|inline)\s+/i;

// User explicitly told the agent NOT to spawn a subagent in plain language.
// Real failure that triggered this: user said "dont spawn a subagent i want
// you to handle your self. Put transformforfitness.com live online. Do it in
// the browser." The build-noun pattern matched ("Put X live") and the system
// spawned anyway, ignoring the explicit override. That's a trust violation —
// user wanted inline, system didn't honor it. ANY of these patterns force
// inline regardless of what other rules would say.
const NO_SPAWN_OVERRIDE_RE = /\b(?:don'?t|do\s*not|no)\s+(?:spawn|delegate|subagent|sub[-\s]?agent|background\s+(?:it|this|task))\b|\b(?:handle|do)\s+(?:it|this|that)\s+(?:your\s*self|yourself)\b|\b(?:you|main\s*agent)\s+do\s+(?:it|this)\s+(?:your\s*self|yourself)?\b|\bnot?\s+(?:a\s+)?subagent\b/i;

export function hasDiscussPrefix(message: string): boolean {
  return DISCUSS_PREFIX_RE.test(message);
}

export function stripDiscussPrefix(message: string): string {
  return message.replace(DISCUSS_PREFIX_RE, "");
}

// Decision log — persistent + in-memory cache. Every shouldAutoDelegate
// call appends one entry to ~/.lax/auto-delegate-decisions.jsonl and to
// the in-memory cache. opId is set later (after delegateMessageToWorker
// returns) for delegated decisions so the UI's "Stay inline" override
// can find the entry and mark userOverride=true. The corrective tag is
// the actual training signal — these are the exact messages where the
// classifier was wrong from the user's POV.
export interface AutoDelegateLogEntry {
  ts: number;
  delegate: boolean;
  reason: string;
  provider: string;
  wordCount: number;
  messagePreview: string;
  /** Full message — needed for the "Stay inline" path to re-submit with /discuss. */
  message?: string;
  /** Set after delegateMessageToWorker returns; lets the UI find this entry by op id. */
  opId?: string;
  /** True if user clicked "Stay inline" — the canonical false-positive signal. */
  userOverride?: boolean;
}

const DECISION_LOG_CAP = 1000;
const decisionLog: AutoDelegateLogEntry[] = [];
let logFilePath: string | null = null;
let logLoaded = false;

function getLogFilePath(): string {
  if (logFilePath) return logFilePath;
  const dir = process.env.LAX_DATA_DIR || join(homedir(), ".lax");
  logFilePath = join(dir, "auto-delegate-decisions.jsonl");
  return logFilePath;
}

function loadLogFromDisk(): void {
  if (logLoaded) return;
  logLoaded = true;
  try {
    const p = getLogFilePath();
    if (!existsSync(p)) return;
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Only keep the tail — we cap in-memory to DECISION_LOG_CAP entries to
    // bound the working set. Disk file rotates separately (see appendDecisionToDisk).
    const tail = lines.slice(-DECISION_LOG_CAP);
    for (const line of tail) {
      try { decisionLog.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  } catch (e) {
    logger.warn(`[auto-delegate] log restore failed: ${(e as Error).message}`);
  }
}

function appendDecisionToDisk(entry: AutoDelegateLogEntry): void {
  try {
    const p = getLogFilePath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
    // Rotate when file grows past ~1MB. Keep the last DECISION_LOG_CAP lines
    // so /api/auto-delegate/recent never returns stale snapshots after rotation.
    const stat = statSync(p);
    if (stat.size > 1_000_000) {
      const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
      if (lines.length > DECISION_LOG_CAP) {
        writeFileSync(p, lines.slice(-DECISION_LOG_CAP).join("\n") + "\n", "utf-8");
      }
    }
  } catch (e) {
    logger.warn(`[auto-delegate] log append failed: ${(e as Error).message}`);
  }
}

function recordDecision(entry: AutoDelegateLogEntry): void {
  loadLogFromDisk();
  decisionLog.push(entry);
  if (decisionLog.length > DECISION_LOG_CAP) {
    decisionLog.splice(0, decisionLog.length - DECISION_LOG_CAP);
  }
  appendDecisionToDisk(entry);
}

export function getRecentAutoDelegateDecisions(limit = 50): AutoDelegateLogEntry[] {
  loadLogFromDisk();
  return decisionLog.slice(-Math.max(1, Math.min(limit, DECISION_LOG_CAP)));
}

// Called by chat.ts AFTER delegateMessageToWorker returns the opId — links
// the decision back to the spawned op so the "Stay inline" UI can find it.
// We assume the most recent DELEGATE decision is the one being linked
// (called within microseconds of the shouldAutoDelegate call).
export function linkDecisionToOpId(opId: string, message: string): void {
  for (let i = decisionLog.length - 1; i >= 0; i--) {
    const e = decisionLog[i];
    if (e.delegate && !e.opId && e.messagePreview === messagePreviewOf(message)) {
      e.opId = opId;
      e.message = message;
      // Re-append so the disk row also has the opId. Disk has an old
      // copy without opId; both stay (the recent one wins on tail read).
      appendDecisionToDisk(e);
      return;
    }
  }
}

function messagePreviewOf(message: string): string {
  return `${message.slice(0, 80).replace(/\s+/g, " ")}${message.length > 80 ? "…" : ""}`;
}

// Called by /api/auto-delegate/override when user clicks "Stay inline" on a
// spawned worker card. Marks the decision as a user-override (training
// signal: this is what the regex got wrong) and returns the original
// message so the chat can re-submit it with /discuss prepended.
export function markDecisionAsUserOverride(opId: string): { message: string | null } {
  for (let i = decisionLog.length - 1; i >= 0; i--) {
    const e = decisionLog[i];
    if (e.opId === opId) {
      e.userOverride = true;
      appendDecisionToDisk(e);
      return { message: e.message || null };
    }
  }
  return { message: null };
}

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
export async function shouldAutoDelegate(provider: string, message: string, channel: string): Promise<boolean> {
  const decision = decideAutoDelegate(provider, message, channel);
  const preview = `${message.slice(0, 80).replace(/\s+/g, " ")}${message.length > 80 ? "…" : ""}`;

  // Model-as-classifier veto — only invoked when regex says DELEGATE. The
  // LLM reads the actual message and can override the regex if the user
  // explicitly asked to stay inline (any phrasing — not just the patterns
  // in DISCUSS_PREFIX_RE / NO_SPAWN_OVERRIDE_RE / DISCUSSION_CUE_RE).
  // This is the escape hatch from "regex hell" — every new user phrasing
  // doesn't require a new pattern, the model just understands intent.
  // Disabled via env LAX_ROUTE_CLASSIFIER=0 if anyone wants pure regex.
  let llmReason: string | null = null;
  let finalDelegate = decision.delegate;
  if (decision.delegate && process.env.LAX_ROUTE_CLASSIFIER !== "0") {
    try {
      const { classifyRouteWithLLM } = await import("./route-classifier.js");
      const llmResult = await classifyRouteWithLLM(message);
      if (llmResult && llmResult.inline) {
        finalDelegate = false;
        llmReason = `LLM-veto: ${llmResult.reason}`;
        logger.info(`[auto-delegate] LLM vetoed regex DELEGATE → INLINE: ${llmResult.reason}`);
      }
    } catch (e) {
      logger.warn(`[auto-delegate] LLM classifier failed (falling back to regex): ${(e as Error).message}`);
    }
  }

  const finalReason = llmReason || decision.reason;
  logger.info(
    `[auto-delegate] decision=${finalDelegate ? "DELEGATE" : "INLINE"} reason=${finalReason} provider=${provider} words=${decision.wordCount} msg="${preview}"`,
  );
  recordDecision({
    ts: Date.now(),
    delegate: finalDelegate,
    reason: finalReason,
    provider,
    wordCount: decision.wordCount,
    messagePreview: preview,
  });
  return finalDelegate;
}

interface AutoDelegateDecision {
  delegate: boolean;
  reason: string;
  wordCount: number;
}

function decideAutoDelegate(provider: string, message: string, channel: string): AutoDelegateDecision {
  if (channel !== "web") return { delegate: false, reason: "non-web-channel", wordCount: 0 };
  const trimmed = message.trim();
  const wordCount = message.split(/\s+/).length;

  // Explicit user override: /discuss prefix ALWAYS forces inline.
  if (DISCUSS_PREFIX_RE.test(message)) {
    return { delegate: false, reason: "discuss-prefix", wordCount };
  }

  // Explicit user override (plain language): "don't spawn a subagent",
  // "handle this yourself", "you do it", etc. ALWAYS forces inline. User
  // trust > classifier confidence. Real bug from 2026-05-02: user said
  // "dont spawn a subagent i want you to handle your self. Put X live"
  // and the build-noun rule fired anyway. Never again — this rule
  // short-circuits before any delegate-class rule.
  if (NO_SPAWN_OVERRIDE_RE.test(message)) {
    return { delegate: false, reason: "user-override-no-spawn", wordCount };
  }

  // Discussion / workshop cues — user is brainstorming or reacting, not
  // asking for fresh research. Keep inline so the agent can synthesize
  // from existing conversation context. Worker would start fresh and
  // lose all that context.
  if (DISCUSSION_CUE_RE.test(message)) {
    return { delegate: false, reason: "discussion-cue", wordCount };
  }

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
    return { delegate: true, reason: "codex-investigative", wordCount };
  }
  if (SHORT_TASK_RE.test(trimmed)) return { delegate: false, reason: "short-task", wordCount };
  if (wordCount >= 50) return { delegate: true, reason: "word-count-50plus", wordCount };
  // Tight verb→noun phrase ("create an app", "build me a dashboard") is on its
  // own enough — those are always multi-file scaffold jobs that should run in
  // a worker, regardless of word count or file-path mentions.
  if (BUILD_NOUN_RE.test(message)) return { delegate: true, reason: "build-noun-phrase", wordCount };
  if (LONG_TASK_VERB_RE.test(message) && (wordCount >= 15 || MULTI_FILE_CUE_RE.test(message))) {
    return { delegate: true, reason: "long-task-verb+context", wordCount };
  }
  return { delegate: false, reason: "no-rule-matched", wordCount };
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

/**
 * LLM-as-classifier — primary decider for routing on ambiguous messages.
 *
 * Pattern: regex (regex-rules.ts) handles three obvious INLINE shortcuts
 * (slash prefix, no-spawn override, ack/greeting). Everything else lands
 * here. The LLM's rule: tools = workers, no tools = chat.
 *
 * Provider: rides on the user's currently-selected provider + model via
 * classifySchema (same path the chat is using). No hardcoded Haiku/Sonnet
 * "cheaper" tricks — the user's chosen Opus/Sonnet/gpt-5/etc. handles
 * routing decisions too. Disabled via LAX_ROUTE_CLASSIFIER=0.
 */

import { z } from "zod";
import { classifySchema } from "../classifiers/schema-output.js";
import type { ClassifierResult } from "./types.js";

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

Reply with JSON only, no prose, no markdown fences:
{"decision": "INLINE" | "DELEGATE", "reason": "one sentence"}`;

/**
 * Verdict schema. A missing/unknown decision is a hard reject (→ retry →
 * null → caller falls back to the regex decision); decision casing and
 * whitespace normalize, and a missing reason coerces rather than rejects.
 * `raw` snapshots the parsed reply pre-normalization, as before.
 */
const RouteVerdictSchema: z.ZodType<ClassifierResult> = z
  .custom<ClassifierResult>(
    (v) => {
      if (!v || typeof v !== "object") return false;
      const decision = (v as { decision?: unknown }).decision;
      if (typeof decision !== "string") return false;
      const normalized = decision.trim().toUpperCase();
      return normalized === "INLINE" || normalized === "DELEGATE";
    },
    { message: `decision must be "INLINE" or "DELEGATE"` },
  )
  .transform((parsed): ClassifierResult => {
    const obj = parsed as { decision?: unknown; reason?: unknown };
    const decision = (obj.decision as string).trim().toUpperCase();
    return {
      inline: decision === "INLINE",
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 240) : "(no reason given)",
      raw: JSON.stringify(parsed).slice(0, 500),
    };
  });

/**
 * Classify a message via the user's selected provider/model. Returns null
 * on any failure — caller falls back to the regex decision.
 */
export async function classifyRouteWithLLM(
  message: string,
  signal?: AbortSignal,
  /** Test seam, forwarded to classifySchema. */
  _llm?: (systemPrompt: string, userPrompt: string) => Promise<string | null>,
): Promise<ClassifierResult | null> {
  // Extremely long messages don't need an LLM call to confirm they're
  // task-class. Save the call.
  if (message.length > 4000) {
    return { inline: false, reason: "message too long, skipping LLM classifier", raw: "(skipped)" };
  }

  const verdict = await classifySchema<ClassifierResult>({
    category: "route",
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    userPrompt: message,
    schema: RouteVerdictSchema,
    shapeHint: `{"decision":"INLINE","reason":"one sentence"}`,
    envDisableVar: "LAX_ROUTE_CLASSIFIER",
    signal,
    _llm,
  });

  return verdict;
}

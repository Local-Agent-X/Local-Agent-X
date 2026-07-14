/**
 * Memory-curate LLM classifier — semantic boost detection.
 *
 * Background: the regex-based teaching-moment detector in prepare-request.ts
 * misses natural language. "you need to toggle to instagram view" is a
 * textbook correction but doesn't match `\b(always|never|next time|...)\b`,
 * so the nudge counter doesn't move and the model never learns the rule.
 *
 * This module is the second-opinion layer. After the regex fast-path runs:
 *   - If regex matched, we already boosted — skip the LLM call (cheap path).
 *   - If regex didn't match, ask Haiku 4.5 "is this a teaching moment?"
 *     and boost on the result. Hard 2s timeout; on any failure return null
 *     and let the cadence-based fire catch it eventually.
 *
 * Cost: ~$0.0004 per call (400 tokens in + 30 out at Haiku rates). For an
 * active session of 50 turns/day, this is < $0.02/day. Negligible vs. the
 * value of catching corrections that regex misses.
 *
 * Privacy: messages get pre-sanitized via redactKnownSecrets before being
 * sent to the classifier. The classifier sees the user's message and a
 * 200-char preview of the prior assistant turn — not the full conversation.
 *
 * Disable via env LAX_MEMORY_CURATE_CLASSIFIER=0 if pure regex/cadence is
 * preferred.
 */

import { z } from "zod";
import { classifySchema } from "../classifiers/schema-output.js";
import { redactKnownSecrets } from "../sanitize.js";
import type { NudgeTrigger } from "./curate-nudge.js";

const CLASSIFIER_TIMEOUT_MS = 2000;

const SHAPE_HINT = `{"teach": true|false, "kind": "preference"|"correction"|"workflow"|"fact"|"explicit-remember"|"none", "confidence": 0-1, "why": "one short phrase"}`;

const SYSTEM_PROMPT = `You decide whether a user message contains durable, transferable knowledge that the agent should save (via the \`remember\` tool for facts, or \`memory_update_profile\` for narrative profile sections).

KIND DEFINITIONS:
- preference: user states a stable preference. "I prefer X", "always do X", "never use Y", "I usually...", workflow choice that should apply to future similar tasks.
- correction: user pushes back on what the agent just did. Includes soft corrections without "no" or "wrong": "you need to toggle to X", "switch to Y", "actually I want Z", "that's facebook stats — I want instagram", "use the other dropdown".
- workflow: user teaches a multi-step procedure for a task type. "first do X, then Y", "the way to handle invoices is...", "for these vendors always...".
- fact: durable fact about the user/business that future sessions should know. "my address is...", "we use vendor X", "the PO# field is actually called Y in our system".
- explicit-remember: user literally asked the agent to remember/save/note something.
- none: routine task, question, ack, greeting, in-task chatter, status check, fresh request with no teaching content.

RULES:
- Only set teach=true if the knowledge would help the agent on a FUTURE session (durable). One-off task instructions (e.g., "open this file") = none.
- Confidence 0.7+ for clear cases, 0.4-0.7 for plausible, <0.4 for uncertain. Caller will only act on >= 0.6.
- A short message is fine — "always sort by date" is teach=true. Length doesn't matter; transferability does.
- If the agent's last message was an action and the user is REDIRECTING that action ("not facebook, instagram"), that's "correction".
- If you're unsure, lean toward teach=false. False positives are worse than false negatives — the cadence-based fire catches misses anyway.`;

export interface ClassifierResult {
  teach: boolean;
  kind: NudgeTrigger | "none";
  confidence: number;
  why: string;
}

// Map classifier kinds to NudgeTrigger names. The classifier emits a
// richer vocabulary than the nudge module's trigger set — collapse to
// the closest existing trigger so the boost amounts apply correctly.
const KIND_TO_TRIGGER: Record<string, NudgeTrigger> = {
  preference: "preference-stated",
  correction: "correction-detected",
  workflow: "preference-stated",       // workflow rules are a kind of preference
  fact: "preference-stated",            // facts about user are durable like prefs
  "explicit-remember": "explicit-remember",
};

/**
 * Reply schema. `kind` is the load-bearing field and is validated strictly
 * (an unknown kind is rejected → single self-correction retry → null).
 * `teach` / `confidence` / `why` keep the old parser's tolerance: a sloppy
 * value degrades (teach→false, confidence→0, why→"") instead of burning the
 * retry — same observable behavior as the hand-rolled parser it replaces.
 */
const TeachSchema = z
  .object({
    teach: z.unknown().optional(),
    kind: z.preprocess(
      (v) => String(v ?? "none").toLowerCase(),
      z.enum(["preference", "correction", "workflow", "fact", "explicit-remember", "none"]),
    ),
    confidence: z.unknown().optional(),
    why: z.unknown().optional(),
  })
  .transform((obj): ClassifierResult => {
    const teach = obj.teach === true;
    const triggerKind = teach && obj.kind !== "none" ? KIND_TO_TRIGGER[obj.kind] : null;
    return {
      teach,
      kind: triggerKind || "none",
      confidence: typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0,
      why: typeof obj.why === "string" ? obj.why.slice(0, 120) : "",
    };
  });

/**
 * Classify whether a user message is a teaching moment worth boosting the
 * memory-curate nudge.
 *
 * Architectural choice: uses the **same model the chat is already running
 * on**, not a per-provider weak-tier table. Cost is bounded (~$0.0004 on
 * Haiku, ~$0.006 worst-case on Opus 4.7) and using the main model means
 * zero model-table maintenance and zero per-provider quality cliffs.
 *
 * Returns null on any failure — caller treats as "no boost from classifier"
 * and falls back to cadence-based nudge.
 *
 * Provider/model/auth are resolved by the canonical classifier wrapper from
 * settings.json (same place the chat resolves from). If the active provider
 * isn't supported by the wrapper (Gemini, etc.), returns null.
 */
export async function classifyTeachMoment(
  userMessage: string,
  lastAssistantPreview: string,
  /** Test seam — forwarded to classifySchema (see its `_llm` doc). */
  _llm?: (systemPrompt: string, userPrompt: string) => Promise<string | null>,
): Promise<ClassifierResult | null> {
  const trimmed = userMessage.trim();
  if (trimmed.length < 4) return null;       // 1-3 char acks ("ok", "ya")
  if (trimmed.length > 4000) return null;    // huge messages skip — likely pasted content

  // Sanitize: strip known secret values registered with the secrets vault
  // so the classifier never sees tokens / passwords / API keys verbatim.
  const safeMsg = redactKnownSecrets(trimmed);
  const safePrev = redactKnownSecrets(lastAssistantPreview.slice(0, 200));

  const userBlock =
    `USER MESSAGE:\n"""${safeMsg}"""\n\n` +
    (safePrev ? `AGENT'S PRIOR MESSAGE (preview, 200ch):\n"""${safePrev}"""\n\n` : "") +
    `Classify per the system rules. JSON only, one line.`;

  return classifySchema<ClassifierResult>({
    category: "curate-teach-moment",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userBlock,
    schema: TeachSchema,
    shapeHint: SHAPE_HINT,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
    maxResponseChars: 500,
    envDisableVar: "LAX_MEMORY_CURATE_CLASSIFIER",
    _llm,
  });
}

/** @internal — for tests */
export const _internals = {
  SYSTEM_PROMPT,
  CLASSIFIER_TIMEOUT_MS,
  TeachSchema,
};

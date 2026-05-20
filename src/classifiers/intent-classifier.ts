/**
 * Intent classifier — picks the single forced tool when the user's ask
 * unambiguously maps to one of three high-leverage primitives:
 *
 *   - build_app    — create a NEW standalone app/dashboard/page/tool
 *   - agent_spawn  — delegate a long-running task to a named role
 *   - self_edit    — repair something broken in THIS app (LAX source)
 *   - free         — anything else; the agent picks its own tool
 *
 * Failure mode this fixes: Primal narrates tool calls in prose
 * (`[Reading routes/]`, `[Calling http_request...]`) instead of emitting
 * structured tool_use blocks when the system prompt's tool-selection
 * guidance is ignored in ambiguous cases. Forcing tool_choice is the
 * structural fix.
 *
 * Provider policy (matches classify-with-llm.ts, revised 2026-05-06):
 * the user's CURRENTLY-SELECTED provider/model handles classification.
 * No hardcoded provider; no Haiku fallback. On any classifier failure
 * (timeout, parse miss, no provider creds) return null — caller treats
 * null as "free." 1.5 s wallclock budget; we never block the chat path
 * on the classifier.
 *
 * Conservative: when in doubt, return "free." Forcing the wrong tool
 * is worse than no forcing.
 */

import { classifyJson } from "./classify-with-llm.js";

export type IntentKind = "build_app" | "agent_spawn" | "self_edit" | "free";

export interface IntentVerdict {
  kind: IntentKind;
  reason: string;
}

interface RawVerdict {
  kind?: string;
  reason?: string;
}

const VALID_KINDS: ReadonlySet<IntentKind> = new Set<IntentKind>([
  "build_app", "agent_spawn", "self_edit", "free",
]);

const SYSTEM_PROMPT = `You decide which tool the assistant should be FORCED to call for this user turn. Reply with a JSON object: {"kind": "<one of: build_app | agent_spawn | self_edit | free>", "reason": "<short reason>"}

KINDS:

- build_app — user is asking to CREATE A NEW STANDALONE app, dashboard, page, tool, tracker, calculator, form, site, or similar artifact. The request is for a fresh thing that doesn't exist yet. Examples:
    "create a dashboard that imports our fastmail"
    "build me a kanban app"
    "make a calculator that converts USD to crypto"
    "scaffold a TODO list page"
    "generate a landing page for X"

- agent_spawn — user is asking to DELEGATE a long-running task to a named role/specialist for execution NOW: research, multi-step writing, code review, market scans, browsing-and-summarizing, anything that benefits from a focused worker run RIGHT NOW. Examples:
    "research current AI voice toolkits and write a summary"
    "have a coder review the kraken bot for bugs"
    "spawn a researcher to find the top 5 GLP-1 supplements"
    "delegate this competitor analysis to a market-research worker"

  NOT agent_spawn (these are SCHEDULING, not immediate delegation — let the model pick mission_schedule_create directly):
    "set up a mission to research X daily"
    "schedule a job to review instagram stats every morning"
    "remind me to check the dashboard every monday"
    "create a cron that fetches Y nightly"
  The word "mission" / "schedule" / "remind me every" / "cron" / "daily / nightly / weekly recurring" = SCHEDULING. Return "free" for these so the model calls the schedule tool directly without a fake worker spawn.

- self_edit — user is REPORTING A BUG OR BROKEN BEHAVIOR in THIS app (Local Agent X / LAX itself). The fix requires touching LAX source code under src/. Examples:
    "the dark-mode toggle doesn't flip when I click it"
    "settings page won't save my provider choice"
    "the voice mic icon is stuck on after I close voice"
    "chat history is getting truncated every turn"
    "edit src/voice/voice-session.ts to wire X"

- free — anything else. Ordinary conversation, status checks, casual questions, ambiguous requests, "how would you build..." (asking for discussion, not the build), "explain", "what is...", short acks, follow-ups, requests that don't unambiguously map to ONE of the three primitives above. When in doubt, choose "free" — forcing the wrong tool is worse than no forcing.

DISTINCTIONS:
- "create a dashboard for fastmail" → build_app (concrete artifact)
- "explain how you'd build a dashboard for fastmail" → free (discussion)
- "research X for me" → agent_spawn (delegation, do it now)
- "set up a mission to research X every night" → free (scheduling — mission_schedule_create, not delegation)
- "remind me daily at 9am to do X" → free (scheduling)
- "tell me about X" → free (just answer it)
- "the toggle doesn't work" → self_edit (LAX bug)
- "fix my todo app's toggle" → free (workspace edit, not LAX source — agent uses edit/write)

Reply with JSON only. No prose, no markdown fences.`;

/**
 * Classify the user message. Returns null on any classifier failure —
 * caller treats null as "free" and does not force a tool.
 *
 * Latency budget: ~1.5 s (the classify-with-llm DEFAULT_TIMEOUT_MS).
 * Disable via `LAX_INTENT_CLASSIFIER=0` if the classifier ever needs to
 * be flipped off without a deploy.
 */
export async function classifyIntent(
  message: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<IntentVerdict | null> {
  const trimmed = (message || "").trim();
  if (!trimmed) return null;

  const userPrompt =
    `User message:\n"${trimmed.slice(0, 1200)}"\n\n` +
    `Return JSON only: {"kind": "build_app" | "agent_spawn" | "self_edit" | "free", "reason": "..."}`;

  const verdict = await classifyJson<IntentVerdict>({
    category: "intent",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: opts?.timeoutMs ?? 8000,
    model: opts?.model,
    envDisableVar: "LAX_INTENT_CLASSIFIER",
    signal: opts?.signal,
    validate: (parsed: unknown): IntentVerdict | null => {
      if (!parsed || typeof parsed !== "object") return null;
      const obj = parsed as RawVerdict;
      const kindRaw = typeof obj.kind === "string" ? obj.kind.trim().toLowerCase() : "";
      if (!VALID_KINDS.has(kindRaw as IntentKind)) return null;
      const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 240) : "";
      return { kind: kindRaw as IntentKind, reason };
    },
  });

  return verdict;
}

// ── Skip-condition helpers ────────────────────────────────────────────────

/**
 * Mirrors `routing/regex-rules.ts` NO_SPAWN_OVERRIDE_RE. Duplicated here
 * rather than imported because routing/ is out of scope for this fix and
 * the regex is tiny + stable. Worth re-syncing if the routing copy
 * changes. Catches "don't spawn / handle this yourself" phrasings — when
 * the user explicitly objects to delegation, we must NOT force a tool.
 */
export const NO_SPAWN_OVERRIDE_RE = /\b(?:don'?t|do\s*not|no)\s+(?:spawn|delegate|subagent|sub[-\s]?agent|background\s+(?:it|this|task))\b|\b(?:handle|do)\s+(?:it|this|that)\s+(?:your\s*self|yourself)\b|\b(?:you|main\s*agent)\s+do\s+(?:it|this)\s+(?:your\s*self|yourself)?\b|\bnot?\s+(?:a\s+)?subagent\b/i;

/**
 * Detect any literal `tool_name({...})` calls in the user message. When
 * the user pastes a literal tool invocation we treat that as explicit
 * intent — skip the classifier so we don't accidentally force a
 * different tool. Returns true if at least one literal call is present.
 */
export function hasLiteralToolCall(message: string): boolean {
  return /\b[a-z_][a-z0-9_]+\s*\(\s*\{/i.test(message);
}

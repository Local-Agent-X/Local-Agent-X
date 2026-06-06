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

- build_app — user is asking to CREATE A NEW STANDALONE, RUNNABLE app, dashboard, page, tool, tracker, calculator, form, site, or similar artifact. The request is for a fresh thing that doesn't exist yet. Examples:
    "create a dashboard that imports our fastmail"
    "build me a kanban app"
    "make a calculator that converts USD to crypto"
    "scaffold a TODO list page"
    "generate a landing page for X"

  NOT build_app — a bare "project" / "workspace" container inside THIS app (Local Agent X). Phrases like "create a project", "new project called X", "add a project for my client work", "start a project" mean a LAX project container, handled by the project_create tool — NOT a standalone runnable artifact. Return "free" for these so the model calls project_create itself. Only classify as build_app when the user clearly wants a runnable app/page/site/tool (the artifact words above), not just an organizational "project".

  NOT build_app — VENTURE / ASPIRATION statements with no explicit artifact-creation verb. "I want to start a company", "I'm thinking of launching a business doing X", "I want to get into the Y space", "help me start a Z brand" express a GOAL that needs discovery (positioning, name, audience, offering) — they are NOT a request to generate a runnable artifact right now. There is no "build / make / create / generate / scaffold / design a <site/page/app/dashboard>" verb on an artifact noun. Return "free" so the agent can ASK what the user actually wants before building anything. Only flip to build_app once the user explicitly asks for the artifact ("now build the landing page", "make me the website"). Forcing build_app on a bare "I want to start a company" is a real failure — it skips discovery and ships an unwanted site. Examples:
    "I want to start an active shooter training company called LIVE" → free (venture; ask first)
    "I'm launching a coffee brand, where do I begin" → free (discovery)
    "help me start a consulting business" → free (discovery)

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

- self_edit — user is REPORTING A BUG OR BROKEN BEHAVIOR in THIS app (Local Agent X / LAX itself). The fix requires touching LAX source code under src/. The user's words must indicate something is BROKEN, MISBEHAVING, or MISSING — not just that they want LAX to do something for them right now. Examples:
    "the dark-mode toggle doesn't flip when I click it"
    "settings page won't save my provider choice"
    "the voice mic icon is stuck on after I close voice"
    "chat history is getting truncated every turn"
    "edit src/voice/voice-session.ts to wire X"

  NOT self_edit — requests to MUTATE USER DATA / UI STATE that LAX already exposes via a tool. These look like "remove / clear / hide / delete / pin / unpin / archive X" where X is user data (chats, conversations, pins, projects, files, secrets, tabs, notifications). LAX has dedicated tools for these (sidebar_clear, sidebar_pin, sidebar_unpin, delete_file, app_delete, project_*, etc.). Return "free" so the agent picks the right tool. Examples:
    "remove all chats from conversation sidebar" → free (sidebar_clear)
    "clear my chat history" → free (sidebar_clear)
    "hide all conversations" → free (sidebar_clear)
    "pin calculator to the sidebar" → free (sidebar_pin)
    "delete the kraken project" → free (project_delete)
  Rule of thumb: if the user is asking to CHANGE WHAT IS DISPLAYED (their data/state in the running app), that's a tool call, not a source edit. self_edit is reserved for "the feature itself is broken / missing in the code."

  NOT self_edit — failures of EXTERNAL devices or networks. TV, router, printer, IoT device, smart-home gear, ADB target, any hardware the user is trying to control through a workspace app. If the user says something doesn't respond, doesn't power on, or won't pair, that's the external thing failing — NOT LAX source. Return "free" so the agent can debug the device itself (network probes, ADB checks, manufacturer protocol guidance).

  NOT self_edit — failures of a WORKSPACE APP the agent built earlier in the session. Anything under workspace/apps/ is user-owned code. When the user says "the dashboard isn't working" / "my todo app's button doesn't fire" / "this app you made doesn't do X", the fix is to edit/write files in that workspace app — NOT touch LAX source. Return "free" so the agent reaches for edit/write/read on workspace paths.

  NOT self_edit — VAGUE FAILURE PHRASES with no explicit LAX feature named. Phrases like "none of them worked", "3 things tried, nothing responded", "still not working", "I tried everything" do NOT by themselves mean LAX is broken — they almost always describe an external thing (device, network, third-party API) failing. Return "free" unless the user explicitly names a LAX feature, route, panel, button, or in-LAX behavior.

- free — anything else. Ordinary conversation, status checks, casual questions, ambiguous requests, "how would you build..." (asking for discussion, not the build), "explain", "what is...", short acks, follow-ups, requests that don't unambiguously map to ONE of the three primitives above. When in doubt, choose "free" — forcing the wrong tool is worse than no forcing.

DISTINCTIONS:
- "create a project" / "new project called X" → free (LAX project container → project_create, NOT a standalone app)
- "build a project management app" → build_app (concrete runnable artifact, despite the word "project")
- "create a dashboard for fastmail" → build_app (concrete artifact)
- "explain how you'd build a dashboard for fastmail" → free (discussion)
- "I want to start a company that does X" → free (venture/aspiration — ask first, no artifact verb)
- "I want to start a training company, build me the website" → build_app (explicit artifact verb present)
- "research X for me" → agent_spawn (delegation, do it now)
- "set up a mission to research X every night" → free (scheduling — mission_schedule_create, not delegation)
- "remind me daily at 9am to do X" → free (scheduling)
- "tell me about X" → free (just answer it)
- "the toggle doesn't work" → self_edit (LAX bug)
- "fix my todo app's toggle" → free (workspace edit, not LAX source — agent uses edit/write)
- "remove all chats from the sidebar" → free (data mutation — sidebar_clear tool exists)
- "the sidebar clear button doesn't work" → self_edit (behavior bug in LAX)
- "the chat UI freezes when I paste an image" → self_edit (LAX feature broken)
- "the TV won't respond to the dashboard" → free (external device, not LAX)
- "my todo app's reorder is broken" → free (workspace app, agent uses edit/write)
- "none of the IPs worked" → free (network/external, not LAX)
- "3 things tried, nothing responded" → free (vague failure — external thing, not LAX)

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

/**
 * Cheap pre-gate: does this message even plausibly map to one of the three
 * forceable intents (build_app / agent_spawn / self_edit)? If not, there's
 * nothing for the LLM classifier to do but return "free" — so skip it.
 *
 * Why this matters: the classifier is an LLM round-trip (on Anthropic it's a
 * Claude-CLI call, 3-8s on Windows). Run on every turn it dominated
 * time-to-first-token while returning "free"/null on ordinary conversation.
 * This gate runs it ONLY when an artifact/delegation/bug signal is present.
 *
 * Deliberately GENEROUS — a false positive just runs the classifier (which
 * then correctly says "free"); a false negative skips forcing on a real
 * build/spawn/fix, but the model still has the tool and can call it itself.
 * So when unsure, lean toward returning true.
 */
const TOOL_FORCING_SIGNAL_RE =
  /\b(build|make|create|scaffold|generate|design|develop|set\s*up|spin\s*up|whip\s*up|rebuild|redesign)\b|\b(app|dashboard|page|site|website|webapp|tool|tracker|calculator|form|landing|widget|game|bot|ui)\b|\b(research|delegate|spawn|agent|worker|sub[-\s]?agent|scan|investigate|summari[sz]e|review|crawl|browse)\b|\b(broken|does\s*n'?t\s+work|do\s*n'?t\s+work|wo\s*n'?t|not\s+working|stuck|bug|glitch|crash(?:ing|es|ed)?|freeze|frozen|froze|fix|error|fails?|failing|broke)\b/i;

export function mightNeedToolForcing(message: string): boolean {
  return TOOL_FORCING_SIGNAL_RE.test(message || "");
}

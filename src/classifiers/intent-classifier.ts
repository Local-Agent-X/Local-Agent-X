/**
 * Intent classifier — grades the user's ask into an intent KIND plus a
 * confidence MODE:
 *
 *   - build_app    — create a NEW standalone app/dashboard/page/tool
 *   - agent_spawn  — delegate a long-running task to a named role
 *   - self_edit    — repair something broken in THIS app (LAX source)
 *   - free         — anything else; the agent picks its own tool
 *
 *   - mode "force" — the ask is explicit AND specified enough to execute
 *                    with no clarifying question; callers may pin
 *                    tool_choice to the kind.
 *   - mode "lean"  — right kind, thin or ambiguous ask; callers must NOT
 *                    pin tool_choice — narrow the tool audience, keep the
 *                    tool loaded, and let the model decide (it may ask
 *                    clarifying questions before executing).
 *
 * Failure mode KIND fixes: the chat agent narrates tool calls in prose
 * (`[Reading routes/]`, `[Calling http_request...]`) instead of emitting
 * structured tool_use blocks when the system prompt's tool-selection
 * guidance is ignored in ambiguous cases. Forcing tool_choice is the
 * structural fix.
 *
 * Failure mode MODE fixes: a bare "build me a page for my gym" classified
 * the same as a fully-specified build ask, hard-forced build_app, and
 * shipped a generic HTML page with zero discovery. The cost asymmetry is
 * lopsided — a missed force is cheap (the model still has the tool), a
 * wrong force ships an unwanted artifact — so forcing requires an
 * explicit, specified ask and everything thinner grades "lean".
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
export type IntentMode = "force" | "lean";

export interface IntentVerdict {
  kind: IntentKind;
  mode: IntentMode;
  reason: string;
}

interface RawVerdict {
  kind?: string;
  mode?: string;
  reason?: string;
}

const VALID_KINDS: ReadonlySet<IntentKind> = new Set<IntentKind>([
  "build_app", "agent_spawn", "self_edit", "free",
]);

const VALID_MODES: ReadonlySet<IntentMode> = new Set<IntentMode>([
  "force", "lean",
]);

const SYSTEM_PROMPT = `You classify the user's message into an intent KIND and a confidence MODE. Reply with a JSON object: {"kind": "<one of: build_app | agent_spawn | self_edit | free>", "mode": "<force | lean>", "reason": "<short reason>"}

THE DEFAULT IS "free". A non-free kind requires an EXPLICIT ask in the message itself: an action verb applied to a concrete object ("build me a kanban app", "research X and write a summary", "the dark-mode toggle doesn't flip"). Aspirations, questions, discussion, and ambiguous phrasing are all "free". When in doubt, return "free" — acting on the wrong kind is far worse than missing one.

MODE — how complete the ask is. Only meaningful for non-free kinds; always use "lean" with kind "free".

- "force" — the ask is explicit AND carries enough specification to execute immediately with no clarifying question. For build_app that means both the artifact AND its purpose/content are stated ("build a BMI calculator with metric units", "make a landing page for my gym with pricing and a signup form"). For agent_spawn the task and deliverable are concrete. For self_edit a specific feature/behavior of THIS app is named as broken.
- "lean" — the kind is right but the ask is thin or one-line, and a good assistant would ask 1-3 clarifying questions (purpose, audience, must-haves) before executing. Examples: "build me a page for my gym", "make me an app", "build a project management app". The assistant keeps the matching tool available but decides for itself whether to ask first or build.

KINDS:

- build_app — user is asking to CREATE A NEW STANDALONE, RUNNABLE app, dashboard, page, tool, tracker, calculator, form, site, or similar artifact. The request is for a fresh thing that doesn't exist yet. Examples:
    "create a dashboard that imports our fastmail"
    "build me a kanban app"
    "make a calculator that converts USD to crypto"
    "scaffold a TODO list page"
    "generate a landing page for X"

  NOT build_app — a bare "project" / "workspace" container inside THIS app (Local Agent X). Phrases like "create a project", "new project called X", "add a project for my client work", "start a project" mean a LAX project container, handled by the project_create tool — NOT a standalone runnable artifact. Return "free" for these so the model calls project_create itself. Only classify as build_app when the user clearly wants a runnable app/page/site/tool (the artifact words above), not just an organizational "project".

  NOT build_app — OFFICE DOCUMENTS. "make a powerpoint / power point / presentation / slide deck / slides", "create a spreadsheet / excel sheet", "write a word doc / report / pdf" are FILE-creation asks served by dedicated tools (the presentation, document, spreadsheet, and pdf tools) — NOT runnable apps. Return "free" for these. A "power point about X" is ALWAYS a .pptx file, never a web app. Examples:
    "make a power point about reckless ben vs minifig" → free (presentation tool)
    "create a spreadsheet of my Q3 expenses" → free (spreadsheet tool)
    "make me a pdf report on the scan results" → free (pdf tool)

  NOT build_app — VENTURE / ASPIRATION statements with no explicit artifact-creation verb. "I want to start a company", "I'm thinking of launching a business doing X", "I want to get into the Y space", "help me start a Z brand" express a GOAL that needs discovery (positioning, name, audience, offering) — they are NOT a request to generate a runnable artifact right now. There is no "build / make / create / generate / scaffold / design a <site/page/app/dashboard>" verb on an artifact noun. Return "free" so the agent can ASK what the user actually wants before building anything. Only flip to build_app once the user explicitly asks for the artifact ("now build the landing page", "make me the website"). Forcing build_app on a bare "I want to start a company" is a real failure — it skips discovery and ships an unwanted site. Examples:
    "I want to start an active shooter training company called LIVE" → free (venture; ask first)
    "I'm launching a coffee brand, where do I begin" → free (discovery)
    "help me start a consulting business" → free (discovery)

- agent_spawn — user is asking to DELEGATE a long-running task to a named role/specialist for execution NOW: research, multi-step writing, code review, market scans, browsing-and-summarizing, anything that benefits from a focused worker run RIGHT NOW. Examples:
    "research current AI voice toolkits and write a summary"
    "have a coder review the scraper bot for bugs"
    "spawn a researcher to find the top 5 note-taking apps"
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

DISTINCTIONS (kind / mode):
- "create a project" / "new project called X" → free (LAX project container → project_create, NOT a standalone app)
- "build a project management app" → build_app / lean (explicit artifact verb, but nothing about what it must do)
- "build me a kanban app" → build_app / force (kanban IS the spec)
- "create a dashboard that imports our fastmail" → build_app / force (artifact + data source stated)
- "build me a page for my gym" → build_app / lean (explicit ask, thin spec — purpose/sections unknown)
- "make me an app" → build_app / lean (explicit but empty spec)
- "make a power point about my trip" → free (office document — presentation tool)
- "make a presentation app with slide transitions" → build_app / force (runnable app, not a .pptx)
- "explain how you'd build a dashboard for fastmail" → free (discussion)
- "I want to start a company that does X" → free (venture/aspiration — ask first, no artifact verb)
- "I want to start a training company, build me the website" → build_app / lean (explicit verb, but site content/audience unstated)
- "research current AI voice toolkits and write a summary" → agent_spawn / force (task + deliverable concrete)
- "research X for me" → agent_spawn / lean (delegation, but scope thin)
- "set up a mission to research X every night" → free (scheduling — mission_schedule_create, not delegation)
- "remind me daily at 9am to do X" → free (scheduling)
- "tell me about X" → free (just answer it)
- "the dark-mode toggle doesn't flip when I click it" → self_edit / force (specific LAX feature named)
- "the toggle doesn't work" → self_edit / lean (LAX bug, but which toggle?)
- "fix my todo app's toggle" → free (workspace edit, not LAX source — agent uses edit/write)
- "remove all chats from the sidebar" → free (data mutation — sidebar_clear tool exists)
- "the sidebar clear button doesn't work" → self_edit / force (behavior bug in LAX, feature named)
- "the chat UI freezes when I paste an image" → self_edit / force (LAX feature broken, repro stated)
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
    `Return JSON only: {"kind": "build_app" | "agent_spawn" | "self_edit" | "free", "mode": "force" | "lean", "reason": "..."}`;

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
      const kind = kindRaw as IntentKind;
      // Fail-soft: a missing/garbled mode must never escalate to forcing,
      // and "free" carries no mode signal at all.
      const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
      const mode: IntentMode =
        kind !== "free" && VALID_MODES.has(modeRaw as IntentMode) ? (modeRaw as IntentMode) : "lean";
      const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 240) : "";
      return { kind, mode, reason };
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

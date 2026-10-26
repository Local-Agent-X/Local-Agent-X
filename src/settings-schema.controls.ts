/**
 * The settings that steer what the agent does and what it may do: approval and
 * learning modes, the kill-switches, the browser policy, the spending caps,
 * run limits, and the model choice. Most are read by the server runtime through
 * config.json (runtime: true).
 *
 * Part of FLIPPABLE_SETTINGS (settings-schema.ts).
 */
import { z } from "zod";
import { MIN_MAX_ITERATIONS } from "./types.js";
import { COMPACT_AT_RANGE, DEFAULT_COMPACT_AT } from "./context-manager/compact-at-range.js";
import type { FlippableSetting } from "./settings-schema.js";

const TOOL_POLICY = "Settings → Security → Tool Policy";
const SKILL_LEARNING = "Settings → Memory → Skill learning";
const SPENDING_LIMITS = "Settings → Usage → Spending limits";

/** The engines `imageEngine` may name (src/tools/image-tools/image-engine.ts). */
export const IMAGE_ENGINES = ["grok", "chatgpt"] as const;

export const CONTROL_SETTINGS: ReadonlyArray<FlippableSetting> = [
  {
    field: "allowRuntimeFailover",
    owner: "agent",
    validate: z.boolean(),
    runtime: false,
    broadcast: true,
    description: "Switch a failed background run to another connected provider or model (on an auth, billing, rate-limit, overload, server-error or timeout failure) and resume it from its last checkpoint; the switch is announced as a line in that run's activity feed. Off by default: a failed run waits and retries on the provider the user chose. Chat turns never switch; exact-runtime retries stay autonomous and bounded",
  },
  // ── Runtime-bound (server reads, must mirror to config.json) ──
  {
    field: "toolApproval",
    owner: "protected", where: "the toolApproval field of their config.json",
    validate: z.enum(["auto", "confirm-risky", "confirm-all"]),
    runtime: true,
    description: "When the AI must ask for permission before running tools. auto=never, confirm-risky=bash/write/edit, confirm-all=every tool",
  },
  {
    field: "learningMode",
    owner: "protected", where: SKILL_LEARNING,
    validate: z.enum(["assisted", "autonomous"]),
    runtime: true,
    broadcast: true,
    description: "How newly learned skills become active. assisted waits for user review; autonomous activates qualified skills within existing permissions",
  },
  {
    field: "skillReviewEnabled",
    owner: "protected", where: SKILL_LEARNING,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Whether finished chat turns are reviewed in the background for reusable procedures. Off stops new learned-workflow drafts; existing ones are untouched",
  },
  {
    field: "bridgeVoicePreference",
    owner: "agent",
    // Keep the "sovits"→"auto" coercion in lockstep with config-schema.ts:
    // both parse the same persisted value, and only one accepting it means
    // the setting flips depending on which path validated it.
    validate: z.preprocess(
      v => (v === "sovits" ? "auto" : v),
      z.enum(["auto", "voxcpm", "chatterbox", "lite", "xai"]),
    ),
    runtime: true,
    description: "Preferred TTS engine for Telegram/WhatsApp bridge replies. auto chooses best available (VoxCPM clone, then Chatterbox, then Lite Kokoro); xai needs the SuperGrok OAuth login",
  },
  {
    field: "maxIterations",
    owner: "agent",
    validate: z.number().int().min(MIN_MAX_ITERATIONS).max(300),
    runtime: true,
    description: `Max tool calls per chat turn (${MIN_MAX_ITERATIONS}-300)`,
  },
  {
    field: "compactAtPercent",
    owner: "agent",
    validate: z.number().int().min(COMPACT_AT_RANGE.min).max(COMPACT_AT_RANGE.max),
    runtime: false,
    broadcast: true,
    description: `Compact at this % of the model's measured context window (${COMPACT_AT_RANGE.min}-${COMPACT_AT_RANGE.max}, default ${DEFAULT_COMPACT_AT}). Between messages the conversation is folded 15 points earlier, so a turn starts with room`,
  },
  {
    field: "maxSubAgents",
    owner: "agent",
    validate: z.number().int().min(1).max(20),
    runtime: true,
    description: "Max sub-agents (agent_spawn) running at once (1-20). Each runs a full agent loop + provider stream + tool subprocesses, so local compute scales with this",
  },
  {
    field: "temperature",
    owner: "agent",
    validate: z.number().min(0).max(2),
    runtime: true,
    description: "LLM sampling temperature (0-2). Lower=more deterministic",
  },
  {
    field: "dailyBudgetUsd",
    owner: "spending-cap", where: SPENDING_LIMITS,
    validate: z.number().min(0),
    runtime: true,
    description: "Daily spending cap in US dollars (default $75). Applies only when you pay per call with an API key: once today's real spend reaches this amount, the agent's tool calls are blocked and the current task ends at its next checkpoint. On a subscription login the cost is shown for information only — it is not a real charge and never stops anything. Set to 0 for no cap",
  },
  {
    field: "sessionBudgetUsd",
    owner: "spending-cap", where: SPENDING_LIMITS,
    validate: z.number().min(0),
    runtime: true,
    description: "Per-session spending cap in US dollars (default $15). Applies only when you pay per call with an API key: once this session's real spend reaches this amount, the agent's tool calls are blocked and the current task ends at its next checkpoint. On a subscription login the cost is shown for information only — it is not a real charge and never stops anything. Set to 0 for no cap",
  },
  {
    field: "modelDailyBudgetsUsd",
    owner: "spending-cap", where: SPENDING_LIMITS,
    validate: z.record(z.number().min(0)),
    runtime: true,
    description: "Per-model daily USD caps on real per-call API spend, keyed by model id. A model over its cap is blocked for the rest of the day. Flat-rate subscription models are never capped",
  },
  {
    field: "enableShell",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL bash tool calls at pre-dispatch",
  },
  {
    field: "enableHttp",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL http_request and ari_http tool calls at pre-dispatch (web_fetch page reads stay on)",
  },
  {
    field: "enableBrowser",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL browser_* tool calls at pre-dispatch",
  },
  {
    field: "browserMode",
    owner: "protected", where: "Settings → Security → Agent Browser Identity",
    validate: z.enum(["isolated", "continuity", "advanced-shared", "in-app"]),
    runtime: true,
    broadcast: true,
    description: "Browser identity mode. in-app=dedicated installed Chrome per chat on Windows for website compatibility, or the embedded co-drivable WebContentsView on non-Windows desktop (including macOS); falls back to isolated CDP when there is no desktop window/bridge. isolated=ephemeral identity per session; continuity=persistent dedicated agent identity with one live session owner; advanced-shared=one live context shared across sessions",
  },
  {
    field: "enableComputerControl",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Category kill-switch — when false, blocks ALL computer (mouse/keyboard) tool calls at pre-dispatch. Off by default (high-risk opt-in; also needs OS Accessibility permission)",
  },
  {
    field: "supervisedBrowser",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Supervised browser mode. Off by default — the in-app browser is autonomous, so browser.evaluate runs without asking. When true, browser.evaluate requires your approval UNLESS the current page is on the trusted-origin allowlist (x.com, twitter.com, instagram.com, facebook.com, tiktok.com, linkedin.com and their subdomains). Supervision is the opt-in; you never have to turn autonomy on",
  },
  {
    field: "browserSecrecy",
    owner: "protected", where: TOOL_POLICY,
    validate: z.enum(["lockdown", "guarded", "ask", "open"]),
    runtime: true,
    broadcast: true,
    description: "Ordered sensitive-page read policy for the agent browser. lockdown = withhold ALL sensitive pages (administration/financial too); guarded = administration/financial readable, secret-bearing pages (password managers, account recovery, key material) silently withheld; ask (default) = secret-bearing reads require your approval; open = everything readable, with a one-time warning when a cloud model would receive page contents. Mutating actions on sensitive pages require approval below open",
  },
  {
    field: "enableUiEventBus",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "UI activity context — when true, redacted user-interface activity (e.g. browser navigation while co-driving) is buffered and injected into the agent's turn context as a short digest. On by default; no field values are ever recorded",
  },
  {
    field: "enableRemoteControl",
    owner: "protected", where: TOOL_POLICY,
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Kill-switch for a paired phone driving mouse/keyboard over the live screen. When false, the live-screen session drops all remote input. Off by default (high-risk opt-in; also needs OS Accessibility permission)",
  },
  {
    field: "localOnlyMode",
    owner: "protected", where: "Settings → Security → Strict Local-Only Mode",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Strict local-only mode. Allows only loopback network access and local models; blocks cloud auth, providers, web tools, remote MCP, connectors, integrations, bridges, account presence, sync, and updates",
  },
  {
    field: "verifyDeliverables",
    owner: "agent",
    validate: z.boolean(),
    runtime: true,
    broadcast: true,
    description: "Independent verification pass when a deliverable is built from external data (a report, spreadsheet, chart) — a background model re-checks the result against its sources, and figures that do not match are corrected in the file, after which the agent tells you in a line what it corrected. Nothing is shown while it checks; a check that confirms the figures says nothing. Covers work done in a chat turn as well as delegated tasks. On by default; it waits until you have stopped editing, then runs ONCE over everything that changed since the last check, so iterating on a file costs one verification and not one per save (unchanged files are never re-checked, and only one verification runs per chat at a time)",
  },
  {
    field: "regressionAuditProvider",
    owner: "agent",
    validate: z.string(),
    runtime: true,
    broadcast: true,
    description: "Optional second provider id (codex, anthropic, xai, openai, gemini, ollama, local) for the regression-audit completion gate — a fresh-eyes pass over every code change that checks for breakage in files the change didn't touch, unfiltered sensitive data reaching a client, error handling that masks real failures, and weakened tests. Empty (default) audits with the SAME model that wrote the change, fresh context. Set this to route the audit to a genuinely different provider instead — needs that provider already connected/credentialed; silently falls back to the same-model audit if it isn't, or if this is set to the provider you're already chatting on",
  },
  {
    field: "regressionAuditModel",
    owner: "agent",
    validate: z.string(),
    runtime: true,
    broadcast: true,
    description: "Model name within regressionAuditProvider (e.g. claude-opus-5, gpt-6-astra, grok-4.6). Empty = that provider's default model. Ignored when regressionAuditProvider is empty",
  },

  // ── UI-only (renderer reads settings.json directly; no runtime mirror needed) ──
  {
    field: "theme",
    owner: "agent",
    validate: z.enum(["light", "dark", "system"]),
    runtime: false,
    broadcast: true,
    description: "Color scheme. system follows OS preference",
  },
  {
    field: "provider",
    owner: "agent",
    validate: z.string().min(1),
    runtime: false,
    broadcast: true,
    description: "LLM provider id (codex, anthropic, xai, gemini, cerebras, ollama, ollama-cloud, local). Switches the model picker",
  },
  {
    field: "model",
    owner: "agent",
    validate: z.string().min(1),
    runtime: false,
    broadcast: true,
    description: "Model name within the chosen provider (gpt-5.5, claude-opus-4-7, grok-4, etc)",
  },
  {
    field: "localClassifierModel",
    owner: "agent",
    validate: z.string(),
    runtime: false,
    broadcast: true,
    description: "Local model to run classifiers/background work on (e.g. llama3.2:3b). Only applies to the 'local' and 'ollama-cloud' providers, which have no declared background model. Empty = the chat model (nothing smaller is chosen for you: src/providers/background-model.ts). Pick a SMALL non-reasoning model: classifiers get an 8s budget and a thinking or 27B+ model burns it and silently returns no verdict",
  },
  {
    field: "reasoningEffort",
    owner: "agent",
    validate: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    runtime: false,
    broadcast: true,
    description: "Thinking depth for reasoning models (gpt-5.x, o-series, grok-4). minimal=fastest, xhigh=deepest (Codex only; clamped to high elsewhere). Default medium",
  },
  {
    field: "developer_mode",
    owner: "protected", where: "Settings → Security → Developer Mode",
    validate: z.boolean(),
    runtime: false,
    // Every open window shows a badge while it's on.
    broadcast: true,
    description: "Unlocks self_edit and autopilot on the platform's own source code. Off by default — customizations go through connectors (~/.lax/connectors), workspace apps, and settings, which all survive updates. Turning this on forks this install's core code: platform updates must then merge with the local edits.",
  },
  {
    field: "imageEngine",
    owner: "agent",
    validate: z.enum(IMAGE_ENGINES),
    runtime: false,
    broadcast: true,
    description: "Default image engine (grok or chatgpt; grok when unset) for generate_image/edit_image when the chat provider has none of its own. A Grok chat always uses Grok and a ChatGPT/OpenAI chat uses ChatGPT; if this engine isn't connected the other one is used and the result says so. Video is Grok whenever xAI is connected. The model can still force a backend per call via the tool's `provider` arg.",
  },
  {
    field: "allowPaidMediaApis",
    owner: "protected", where: "Settings → Media → Image Generation",
    validate: z.boolean(),
    runtime: false,
    broadcast: true,
    description: "Allow paid API keys for images and video. Off by default: generate_image, edit_image (masked edits included) and generate_video then never use an OpenAI or xAI API key, which is billed per image or video, only the ChatGPT and SuperGrok sign-ins and local Stable Diffusion / CogVideoX; a request for a paid backend is refused. On: API keys are used as before, a sign-in still preferred over a key for the same engine",
  },
];

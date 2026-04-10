import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SAXConfig, DeploymentProfile, ProfileDefaults } from "./types.js";

// ── Deployment Profile Defaults ──
// Each profile bundles sane defaults for its target audience.
// "home"       — single user, max ease, secure but hands-off
// "dev"        — local development, relaxed policies, verbose logs
// "enterprise" — locked down, full audit, confirm everything

export const PROFILE_DEFAULTS: Record<DeploymentProfile, ProfileDefaults> = {
  home: {
    sandboxMode: "host",
    toolApproval: "confirm-all",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  dev: {
    sandboxMode: "host",
    toolApproval: "auto",
    retentionDays: 90,
    autoUpdate: true,
    networkExposure: "localhost",
    logLevel: "detailed",
  },
  enterprise: {
    sandboxMode: "docker",
    toolApproval: "confirm-all",
    retentionDays: 30,
    autoUpdate: false,
    networkExposure: "localhost",
    logLevel: "full-audit",
  },
};

// ── System Prompt Sections ──
// Split into sections so that lighter-context providers (Codex 128k) can skip
// sections that aren't relevant and save thousands of tokens per request.
// The full prompt assembles all sections; Codex gets only CORE + COMPACT.

export const PROMPT_CORE = `You are a personal AI companion running inside Open Agent X.
You are the user's personal AI agent — their orchestrator and right hand.
${process.platform === "win32" ? "You are running on Windows. The bash tool executes PowerShell. Use PowerShell syntax and Windows paths. Do NOT use Unix commands or Unix paths." : "You are running on Linux/macOS. The bash tool executes /bin/bash."}

## Tooling
Tool names are case-sensitive. Call tools exactly as listed. Use tool_search to discover tools not in your current list.
ALWAYS call protocol_get before executing a workflow.
Prefer built-in tools when they fit. Use bash or Python for anything else.

## Strategy
List first, peek second, act third. Never start by reading a huge file.
For large files: use python -c. Never use the read tool on files over 10000 lines.
NEVER ask for permission or approval before running a tool — just do it.

## Self-Recovery
Try first, ask second. Retry on errors, try alternatives on command-not-found, search for files before giving up.
Complete the steps that work. Don't abandon a task because one step failed.

## Memory
Check auto-loaded memory context before answering about prior work, decisions, people, or preferences.
If not in loaded context, call memory_search before saying "I don't know."
NEVER output memory context tags in your response.
PROACTIVELY retain facts with memory_save(target="retain", content="KIND @entity: fact"). W=world, O=observation, S=sentiment, B=belief.

## Identity
"Open Agent X" is the PLATFORM, not your name. Use your name from <agent_identity>. Never introduce yourself as "Agent X".

## Personality
Warm but direct. Talk like a trusted friend. Match their energy. Never expose internal memory details.`;

export const PROMPT_DELEGATION = `
## Delegation
For HEAVY work (coding, research, multi-step workflows): delegate to agents. Spawn and move on.
For LIGHTWEIGHT tasks (1-2 tool calls): do them yourself.
After spawning an agent, tell the user and STOP. Do NOT poll agent_status unprompted.

How to delegate:
- delegate: auto-analyze and spawn the right agents (preferred)
- agent_spawn: manually spawn one agent with role and task
- agent_status: check progress (only when user asks)
- agent_cancel: cancel an agent
Agent roles: researcher, writer, coder, reviewer, social-media, analyst, monitor, designer, ops, communicator

BLOCKED AGENTS: When an agent reports a blocker, tell the user, then use agent_message to relay their response.`;

export const PROMPT_BROWSER = `
## Browser
Use the browser tool yourself — don't tell the user to open things.
Workflow: navigate → snapshot → click ref=N / fill ref=N.
One browser session, multiple tabs. Check tabs first before navigating.
Self-recovery: refresh on incomplete loads, close popups, retry on timeout.
Use web_search for lookups, browser for interaction (forms, clicks, scraping).`;

export const PROMPT_MEMORY_FULL = `
## Memory Details
Fact format: "KIND @entity: fact" — W=world, O=observation, S=sentiment, B=belief.
Retain: personal (pets, family, job), project (decisions, architecture, milestones), technical (stack, ports), workflow (preferences, patterns), people/entities.
Do NOT retain: debug output, tool errors, temporary troubleshooting.
When learning about the user: call memory_update_profile to update USER.md, IDENTITY.md, HEART.md, or MIND.md.
If memory context is empty (first conversation), open with: "Agent activated. Awaiting designation. What's my callsign, and who am I reporting to?"`;

export const PROMPT_WORKSPACE = `
## Workspace
Working directory is the Open Agent X project root. Use relative paths from project root or absolute Windows paths.
File links: [Open filename.ext](workspace/filename.ext) — always relative, never absolute.
To open a file: use bash with "start" on Windows. To open a folder: "explorer.exe".

### File Organization
Project files: workspace/projects/{project-name}/{docs,pdfs,spreadsheets,presentations,images}/
One-off files: workspace/{docs,pdfs,spreadsheets,presentations,images,reports}/
Apps: workspace/apps/{app-name}/`;

export const PROMPT_APPS = `
## Building Apps
Two ways: app_create (preferred, interactive, appears in gallery) or workspace/apps/ (complex, multi-file).
Default to app_create unless the app needs multiple files or a framework.
After building: give clickable markdown link. Read PROJECT.md/TODO.md before resuming work on existing apps.`;

export const PROMPT_BUSINESS_TOOLS = `
## Business & Personal Assistant Tools
Available via tool_search: sql_query, email_read/send, calendar_list/create, contacts_search, cloud_list/upload, notify, spreadsheet_read/write, pdf_read/create, payment_balance, sms_send, voice_transcribe, clipboard_read/write, crm_contacts_search, accounting_transactions, shop_orders.
All use secrets for API credentials. If missing, use request_secret.`;

export const PROMPT_INTEGRATIONS = `
## API Integrations
Use http_request with secret names as \`{{SECRET_NAME}}\` in the Authorization header.
To add new integrations: POST to /api/integrations with the config, then user adds their API key in Settings.`;

export const PROMPT_PROTOCOLS = `
## Protocols
When the user asks to do something matching a protocol: call protocol_get FIRST.
Follow steps in order. Don't skip. Save new preferences learned during the workflow.`;

export const PROMPT_SECURITY = `
## ARI Kernel Security
Every tool call passes through ARI before execution. Cannot be overridden.
If a tool call is denied, explain why to the user.`;

// Full prompt (all sections) for 200k+ context models (Claude, Grok, Gemini)
const DEFAULT_SYSTEM_PROMPT = [
  PROMPT_CORE,
  PROMPT_DELEGATION,
  PROMPT_BROWSER,
  PROMPT_MEMORY_FULL,
  PROMPT_WORKSPACE,
  PROMPT_APPS,
  PROMPT_BUSINESS_TOOLS,
  PROMPT_INTEGRATIONS,
  PROMPT_PROTOCOLS,
  PROMPT_SECURITY,
].join("\n");

// Compact prompt for Codex (128k context) — core only, ~2k tokens vs ~8k full
export const COMPACT_SYSTEM_PROMPT = PROMPT_CORE;

const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7007),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-3-mini"),
  maxIterations: z.number().int().min(1).max(100).default(25),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  profile: z.enum(["home", "dev", "enterprise"]).default("home"),
  toolApproval: z.enum(["auto", "confirm-risky", "confirm-all"]).default("confirm-risky"),
  retentionDays: z.number().int().min(7).max(365).default(90),
  autoUpdate: z.boolean().default(true),
  logLevel: z.enum(["basic", "detailed", "full-audit"]).default("basic"),

  // Service URLs
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  sdServerUrl: z.string().default("http://127.0.0.1:7860"),
  videoServerUrl: z.string().default("http://127.0.0.1:7861"),
  xttsServerUrl: z.string().default("http://127.0.0.1:7862"),

  // Limits & timeouts
  browserCdpPort: z.number().int().min(1).max(65535).default(9800),
  browserIdleTimeoutMs: z.number().int().min(60000).default(600000),
  rateLimitMax: z.number().int().min(1).default(120),
  rateLimitRefillPerSec: z.number().int().min(1).default(10),
  maxRequestBodyBytes: z.number().int().min(1).default(10485760),
  maxUploadBytes: z.number().int().min(1).default(104857600),
  maxAudioBytes: z.number().int().min(1).default(26214400),
  authMaxFailures: z.number().int().min(1).default(20),
  authLockoutMs: z.number().int().min(1000).default(60000),
  agentTimeoutMs: z.number().int().min(10000).default(600000),
  maxCachedSessions: z.number().int().min(1).default(200),
});

function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set");
  }
  const dir = join(home, ".sax");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function generateAuthToken(): string {
  return randomBytes(32).toString("hex"); // 256-bit token
}

export function loadConfig(): SAXConfig {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.warn(`[config] Failed to parse ${configPath}, using defaults`);
    }
  }

  // Environment variable overrides
  if (process.env.XAI_API_KEY) raw.openaiApiKey = process.env.XAI_API_KEY;
  if (process.env.OPENAI_API_KEY) raw.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.SAX_PORT) raw.port = parseInt(process.env.SAX_PORT, 10);
  if (process.env.SAX_AUTH_TOKEN) raw.authToken = process.env.SAX_AUTH_TOKEN;
  if (process.env.SAX_WORKSPACE) raw.workspace = process.env.SAX_WORKSPACE;
  if (process.env.SAX_MODEL) raw.model = process.env.SAX_MODEL;

  // Service URL overrides
  if (process.env.SAX_OLLAMA_URL) raw.ollamaUrl = process.env.SAX_OLLAMA_URL;
  if (process.env.SAX_SD_SERVER_URL) raw.sdServerUrl = process.env.SAX_SD_SERVER_URL;
  if (process.env.SAX_VIDEO_SERVER_URL) raw.videoServerUrl = process.env.SAX_VIDEO_SERVER_URL;
  if (process.env.SAX_XTTS_SERVER_URL) raw.xttsServerUrl = process.env.SAX_XTTS_SERVER_URL;

  // Limit/timeout overrides
  if (process.env.SAX_AGENT_TIMEOUT_MS) raw.agentTimeoutMs = parseInt(process.env.SAX_AGENT_TIMEOUT_MS, 10);
  if (process.env.SAX_MAX_UPLOAD_BYTES) raw.maxUploadBytes = parseInt(process.env.SAX_MAX_UPLOAD_BYTES, 10);
  if (process.env.SAX_RATE_LIMIT_MAX) raw.rateLimitMax = parseInt(process.env.SAX_RATE_LIMIT_MAX, 10);

  // Environment variable for profile override
  if (process.env.SAX_PROFILE) raw.profile = process.env.SAX_PROFILE;

  const config = configSchema.parse(raw);

  // Apply profile defaults for any fields the user hasn't explicitly set
  const profileDefaults = PROFILE_DEFAULTS[config.profile];
  if (!raw.toolApproval) config.toolApproval = profileDefaults.toolApproval;
  if (!raw.retentionDays) config.retentionDays = profileDefaults.retentionDays;
  if (raw.autoUpdate === undefined) config.autoUpdate = profileDefaults.autoUpdate;
  if (!raw.logLevel) config.logLevel = profileDefaults.logLevel;

  // Inject actual app URL into system prompt (works with any port)
  const appUrl = `http://127.0.0.1:${config.port}`;
  config.systemPrompt = config.systemPrompt.replace(/\{\{APP_URL\}\}/g, appUrl);

  // Auto-generate auth token if missing
  if (!config.authToken) {
    config.authToken = generateAuthToken();
    saveConfig(config);
    console.log("[config] Generated new auth token (see ~/.sax/config.json)");
  }

  return config;
}

export function saveConfig(config: SAXConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

// ── Runtime config store ──
// Set once at startup, readable from any module without threading config through every call.

let _runtimeConfig: SAXConfig | null = null;

export function setRuntimeConfig(config: SAXConfig): void {
  _runtimeConfig = config;
}

export function getRuntimeConfig(): SAXConfig {
  if (!_runtimeConfig) {
    // Fallback: load from disk (should only happen in tests or edge cases)
    _runtimeConfig = loadConfig();
  }
  return _runtimeConfig;
}

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

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI companion running inside Open Agent X.

## Core Rules
0. ALWAYS respond to the user's LATEST message first. If they change the topic, follow them.
1. NEVER claim you did something without calling the tool. Every action requires a real tool call. Do NOT invent IDs, paths, or timestamps.
2. After a tool call, report the ACTUAL result. If it errored, say so.
3. Prefer built-in tools over scripts (use spreadsheet_read not pandas, glob not bash find, web_search not browser for lookups).
4. Use tool_search to discover tools not in your current list.
5. When creating files, give clickable links: [Open file.docx](workspace/file.docx). To physically open: bash "start workspace\\file.docx".

## Delegation
Do it yourself for 1-2 tool calls. Delegate (agent_spawn or delegate) for 3+ calls or heavy work (coding, research, multi-step browser).
After spawning: tell the user it's being worked on and STOP. Only check agent_status when the USER asks.
If an agent is blocked (login, error): relay to user, then use agent_message when they respond.

## Missions (workflows)
For multi-step workflows (e.g. "post on instagram"): call mission_get first to load steps/rules/preferences, then follow them strictly.
For simple actions (scheduling, saving, file ops): call the tool directly — do NOT call mission_get.
To schedule recurring tasks: use mission_schedule_create with { name, schedule, prompt }.

## Browser
Use browser for page interaction (click, fill, scrape). Use web_search for information lookups.
Workflow: tabs → navigate/switch_tab → snapshot → click/fill ref=N.
One browser session, multiple tabs. Check tabs before navigating — switch to existing tabs, don't re-open.
Self-recover: refresh on incomplete loads, close popups, retry on timeouts. Only ask user for CAPTCHAs and expired logins.

## Apps
When the user asks to build, create, or edit an app: do it yourself using write/edit/read tools directly. Save files to workspace/apps/{app-name}/. The main entry point must be index.html. For single-page apps, inline CSS and JS. Make it polished.
After creating files, give the user: [Open App Name](http://127.0.0.1:PORT/apps/{app-name}/index.html)
Simple stateful dashboards: use app_create instead.
Runtime-first: when user wants to USE an app (add data, check status), interact via browser/http_request — don't edit code.

## Memory
Use the auto-loaded memory context (<agent_identity>, <user_profile>, <core_memory>, etc.) before answering about prior work or preferences.
When user shares facts: call memory_save. When you learn about the user: call memory_update_profile.
If no identity set: ask the user to name you. "Open Agent X" is the platform, not your name.

## Personality
Warm but direct. Match their energy. Use their name naturally. Never expose internal memory details.
Never ask for info already in your memory context. Never treat the user like a stranger if you have memories of them.

## Self-Recovery
Try first, ask second. Retry on errors (2 attempts), try alternatives for command-not-found, search for missing files.
On partial failure: complete what works, report what failed. Never abandon a task over one failed step.

## Workspace
Save user files to workspace/. Apps go in workspace/apps/{name}/. Use relative paths (never ~ or /home/).
Key paths: public/ (UI), src/ (backend), workspace/apps/ (user apps).

## Security
ARI Kernel inspects every tool call. If blocked, explain why. You cannot bypass it.
API integrations use \`{{SECRET_NAME}}\` in headers — the server resolves secrets automatically.`;


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
  agentTimeoutMs: z.number().int().min(10000).default(300000),
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

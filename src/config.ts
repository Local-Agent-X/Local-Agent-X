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

// System prompt is loaded from config/system-prompt.md (agent-editable safe zone).
// Falls back to a minimal prompt if the file is missing.
import { loadSystemPrompt, startConfigWatcher } from "./config-loader.js";
import { writeManifest, startManifestWatcher } from "./manifest-generator.js";
const DEFAULT_SYSTEM_PROMPT = loadSystemPrompt() || "You are a personal AI companion running inside Open Agent X. Use your tools to help the user.";

// Generate manifest and start watchers for hot-reload
writeManifest();
startConfigWatcher();
startManifestWatcher();


const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7007),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-3-mini"),
  maxIterations: z.number().int().min(1).max(100).default(40),
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

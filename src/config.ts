import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LAXConfig, DeploymentProfile, ProfileDefaults } from "./types.js";

import { createLogger } from "./logger.js";
const logger = createLogger("config");

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
const DEFAULT_SYSTEM_PROMPT = loadSystemPrompt() || "You are a personal AI companion running inside Local Agent X. Use your tools to help the user.";

// Generate manifest and start watchers for hot-reload
writeManifest();
startConfigWatcher();
startManifestWatcher();


const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7007),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-4"),
  maxIterations: z.number().int().min(1).max(300).default(160),
  temperature: z.number().min(0).max(2).default(0.7),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  profile: z.enum(["home", "dev", "enterprise"]).default("home"),
  toolApproval: z.enum(["auto", "confirm-risky", "confirm-all"]).default("confirm-risky"),
  retentionDays: z.number().int().min(7).max(365).default(90),
  autoUpdate: z.boolean().default(true),
  logLevel: z.enum(["basic", "detailed", "full-audit"]).default("basic"),

  // AriKernel kill-switch posture. true = if the kernel fails to start
  // or evaluate, BLOCK the tool call (and refuse to boot the server on
  // a hard wiring failure). false = fail-open through the kernel layer
  // (other defense layers — session policy, SecurityLayer, default
  // rules, threat engine — still defend). Defaults to true everywhere
  // so the deepest gate is load-bearing on fresh installs. Override
  // with LAX_ARI_REQUIRED=false ONLY for emergency debugging when the
  // kernel is wedged.
  ariRequired: z.boolean().default(true),

  // Service URLs
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  /** Ollama Cloud (Turbo) endpoint. When set + OLLAMA_CLOUD_API_KEY secret
   *  is present, the Ollama provider lists cloud models alongside local
   *  ones in the picker and routes per-model. Empty disables cloud. */
  ollamaCloudUrl: z.string().default("https://ollama.com"),
  sdServerUrl: z.string().default("http://127.0.0.1:7860"),
  videoServerUrl: z.string().default("http://127.0.0.1:7861"),
  xttsServerUrl: z.string().default("http://127.0.0.1:7862"),

  // Browser mode. "isolated" = dedicated agent profile at ~/.lax/chrome-profile
  // (safer — zero blast radius on personal browsing). "attach" = launches against
  // your real Chrome profile so the agent inherits all your logins; requires
  // your regular Chrome to be closed (Chrome forbids two instances on one profile).
  browserMode: z.enum(["isolated", "attach"]).default("isolated"),

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
  bridgeVoicePreference: z.enum(["auto", "sovits", "chatterbox", "lite"]).default("auto"),
});

function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    throw new Error("Cannot determine home directory: neither HOME nor USERPROFILE is set");
  }
  const dir = join(home, ".lax");
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

export function loadConfig(): LAXConfig {
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      logger.warn(`[config] Failed to parse ${configPath}, using defaults`);
    }
  }

  // Environment variable overrides
  if (process.env.XAI_API_KEY) raw.openaiApiKey = process.env.XAI_API_KEY;
  if (process.env.OPENAI_API_KEY) raw.openaiApiKey = process.env.OPENAI_API_KEY;
  const portEnv = process.env.LAX_PORT ?? process.env.SAX_PORT;
  if (portEnv) raw.port = parseInt(portEnv, 10);
  const authTokenEnv = process.env.LAX_AUTH_TOKEN ?? process.env.SAX_AUTH_TOKEN;
  if (authTokenEnv) raw.authToken = authTokenEnv;
  const workspaceEnv = process.env.LAX_WORKSPACE ?? process.env.SAX_WORKSPACE;
  if (workspaceEnv) raw.workspace = workspaceEnv;
  const modelEnv = process.env.LAX_MODEL ?? process.env.SAX_MODEL;
  if (modelEnv) raw.model = modelEnv;

  // Service URL overrides
  const ollamaEnv = process.env.LAX_OLLAMA_URL ?? process.env.SAX_OLLAMA_URL;
  if (ollamaEnv) raw.ollamaUrl = ollamaEnv;
  const ollamaCloudEnv = process.env.LAX_OLLAMA_CLOUD_URL ?? process.env.SAX_OLLAMA_CLOUD_URL;
  if (ollamaCloudEnv) raw.ollamaCloudUrl = ollamaCloudEnv;
  const sdEnv = process.env.LAX_SD_SERVER_URL ?? process.env.SAX_SD_SERVER_URL;
  if (sdEnv) raw.sdServerUrl = sdEnv;
  const videoEnv = process.env.LAX_VIDEO_SERVER_URL ?? process.env.SAX_VIDEO_SERVER_URL;
  if (videoEnv) raw.videoServerUrl = videoEnv;
  const xttsEnv = process.env.LAX_XTTS_SERVER_URL ?? process.env.SAX_XTTS_SERVER_URL;
  if (xttsEnv) raw.xttsServerUrl = xttsEnv;

  // Limit/timeout overrides
  const agentTimeoutEnv = process.env.LAX_AGENT_TIMEOUT_MS ?? process.env.SAX_AGENT_TIMEOUT_MS;
  if (agentTimeoutEnv) raw.agentTimeoutMs = parseInt(agentTimeoutEnv, 10);
  const maxUploadEnv = process.env.LAX_MAX_UPLOAD_BYTES ?? process.env.SAX_MAX_UPLOAD_BYTES;
  if (maxUploadEnv) raw.maxUploadBytes = parseInt(maxUploadEnv, 10);
  const rateLimitEnv = process.env.LAX_RATE_LIMIT_MAX ?? process.env.SAX_RATE_LIMIT_MAX;
  if (rateLimitEnv) raw.rateLimitMax = parseInt(rateLimitEnv, 10);

  // Environment variable for profile override
  const profileEnv = process.env.LAX_PROFILE ?? process.env.SAX_PROFILE;
  if (profileEnv) raw.profile = profileEnv;

  // AriKernel kill-switch override. Default-true via schema; this is the
  // emergency escape hatch for debugging a wedged kernel. Treat "false"
  // and "0" as off; anything else (including "true", "1", empty) keeps
  // the schema default.
  const ariReqEnv = process.env.LAX_ARI_REQUIRED ?? process.env.SAX_ARI_REQUIRED;
  if (ariReqEnv !== undefined) raw.ariRequired = ariReqEnv !== "false" && ariReqEnv !== "0";

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
    logger.info("[config] Generated new auth token (see ~/.lax/config.json)");
  }

  return config;
}

export function saveConfig(config: LAXConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

// ── Runtime config store ──
// Set once at startup, readable from any module without threading config through every call.

let _runtimeConfig: LAXConfig | null = null;

export function setRuntimeConfig(config: LAXConfig): void {
  _runtimeConfig = config;
}

export function getRuntimeConfig(): LAXConfig {
  if (!_runtimeConfig) {
    // Fallback: load from disk (should only happen in tests or edge cases)
    _runtimeConfig = loadConfig();
  }
  return _runtimeConfig;
}

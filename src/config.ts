import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { LAXConfig, DeploymentProfile, ProfileDefaults } from "./types.js";
import { getLaxDir } from "./lax-data-dir.js";

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
    toolApproval: "auto",
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
import { writeManifest, startManifestWatcher } from "./manifest-generator/index.js";
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
  toolApproval: z.enum(["auto", "confirm-risky", "confirm-all"]).default("auto"),
  retentionDays: z.number().int().min(7).max(365).default(90),
  autoUpdate: z.boolean().default(true),
  logLevel: z.enum(["basic", "detailed", "full-audit"]).default("basic"),
  /** Bash sandbox mode. "host" runs commands directly on the host OS (default,
   *  full functionality). "docker" runs commands inside a network-isolated
   *  Alpine container — opt-in for paranoid setups; breaks host-OS commands
   *  and network access. Toggleable from Settings → Security. */
  sandboxMode: z.enum(["host", "docker"]).default("host"),

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

  // Per-session browser context. Off by default: all sessions share one
  // browser context, so cookies/logins carry across chats and missions
  // (continuity). On: each session gets its own context (separate cookie
  // jar) inside the same Chrome — full isolation when sessions must not
  // share authenticated state. Tabs and element refs are always
  // per-session regardless of this flag.
  browserPerSessionContext: z.boolean().default(false),

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
  bridgeVoicePreference: z.enum(["auto", "sovits", "chatterbox", "lite", "xai"]).default("auto"),

  /** Category-level kill-switches behind the Tool Policy toggles in
   *  Settings → Security. Default-on so the out-of-box agent has full
   *  capability; flipping off blocks every tool in the category at
   *  pre-dispatch with a clear "category disabled" reason. Sits OVER the
   *  granular tool-policy rule engine — these are user-friendly surface-
   *  area toggles, not replacements for per-rule allow/deny logic. */
  enableShell: z.boolean().default(true),
  enableHttp: z.boolean().default(true),
  enableBrowser: z.boolean().default(true),
});

function getConfigDir(): string {
  const dir = getLaxDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getConfigPath(): string {
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
  const portEnv = process.env.LAX_PORT;
  if (portEnv) raw.port = parseInt(portEnv, 10);
  const authTokenEnv = process.env.LAX_AUTH_TOKEN;
  if (authTokenEnv) raw.authToken = authTokenEnv;
  const workspaceEnv = process.env.LAX_WORKSPACE;
  if (workspaceEnv) raw.workspace = workspaceEnv;
  const modelEnv = process.env.LAX_MODEL;
  if (modelEnv) raw.model = modelEnv;

  // Service URL overrides
  const ollamaEnv = process.env.LAX_OLLAMA_URL;
  if (ollamaEnv) raw.ollamaUrl = ollamaEnv;
  const ollamaCloudEnv = process.env.LAX_OLLAMA_CLOUD_URL;
  if (ollamaCloudEnv) raw.ollamaCloudUrl = ollamaCloudEnv;
  const sdEnv = process.env.LAX_SD_SERVER_URL;
  if (sdEnv) raw.sdServerUrl = sdEnv;
  const videoEnv = process.env.LAX_VIDEO_SERVER_URL;
  if (videoEnv) raw.videoServerUrl = videoEnv;
  const xttsEnv = process.env.LAX_XTTS_SERVER_URL;
  if (xttsEnv) raw.xttsServerUrl = xttsEnv;

  // Limit/timeout overrides
  const agentTimeoutEnv = process.env.LAX_AGENT_TIMEOUT_MS;
  if (agentTimeoutEnv) raw.agentTimeoutMs = parseInt(agentTimeoutEnv, 10);
  const maxUploadEnv = process.env.LAX_MAX_UPLOAD_BYTES;
  if (maxUploadEnv) raw.maxUploadBytes = parseInt(maxUploadEnv, 10);
  const rateLimitEnv = process.env.LAX_RATE_LIMIT_MAX;
  if (rateLimitEnv) raw.rateLimitMax = parseInt(rateLimitEnv, 10);

  // Environment variable for profile override
  const profileEnv = process.env.LAX_PROFILE;
  if (profileEnv) raw.profile = profileEnv;

  // AriKernel kill-switch override. Default-true via schema; this is the
  // emergency escape hatch for debugging a wedged kernel. Treat "false"
  // and "0" as off; anything else (including "true", "1", empty) keeps
  // the schema default.
  const ariReqEnv = process.env.LAX_ARI_REQUIRED;
  if (ariReqEnv !== undefined) raw.ariRequired = ariReqEnv !== "false" && ariReqEnv !== "0";

  const config = configSchema.parse(raw);

  // Apply profile defaults for any fields the user hasn't explicitly set
  const profileDefaults = PROFILE_DEFAULTS[config.profile];
  if (!raw.toolApproval) config.toolApproval = profileDefaults.toolApproval;
  if (!raw.retentionDays) config.retentionDays = profileDefaults.retentionDays;
  if (raw.autoUpdate === undefined) config.autoUpdate = profileDefaults.autoUpdate;
  if (!raw.logLevel) config.logLevel = profileDefaults.logLevel;

  // Workspace location. The packaged desktop app sets LAX_DOCUMENTS_DIR so the
  // agent workspace lives in the user's Documents (findable in Finder/Explorer,
  // survives updates) instead of the hidden install dir that "./workspace"
  // resolves into. When the saved value is still the legacy default, move any
  // existing files over once and persist the absolute path — after that the
  // value is non-legacy and this never runs again. Dev / standalone server
  // (no LAX_DOCUMENTS_DIR) keeps "./workspace".
  const docsDir = process.env.LAX_DOCUMENTS_DIR;
  const legacyWorkspace = raw.workspace === undefined || raw.workspace === "./workspace";
  if (docsDir && legacyWorkspace) {
    const newWorkspace = join(docsDir, "Local Agent X");
    migrateWorkspace(resolve(config.workspace), newWorkspace);
    config.workspace = newWorkspace;
    saveConfig(config);
  }

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
  // Atomic write — write to .tmp then rename. Prevents a concurrent
  // reader (server boot, settings POST handler, hot-reload) from
  // seeing a half-written config.json and crashing on JSON.parse.
  // Inline here (rather than the shared server-utils helper) because
  // server-utils imports from config, so the dep would be circular.
  const tmp = `${configPath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, configPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// Move files off the legacy install-dir workspace into the new Documents
// workspace. Per-entry and non-clobbering; falls back to copy+delete when a
// rename would cross devices. Best-effort — a failed entry is logged and
// skipped rather than aborting startup.
function migrateWorkspace(oldWorkspace: string, newWorkspace: string): void {
  if (oldWorkspace === newWorkspace) return;
  mkdirSync(newWorkspace, { recursive: true });
  if (!existsSync(oldWorkspace)) return;
  let moved = 0;
  for (const entry of readdirSync(oldWorkspace)) {
    const from = join(oldWorkspace, entry);
    const to = join(newWorkspace, entry);
    if (existsSync(to)) continue; // never overwrite something already at the destination
    try {
      renameSync(from, to);
      moved++;
    } catch {
      try {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
        moved++;
      } catch (e) {
        logger.warn(`[config] workspace migrate skipped "${entry}": ${(e as Error).message}`);
      }
    }
  }
  if (moved) logger.info(`[config] migrated ${moved} workspace item(s): ${oldWorkspace} → ${newWorkspace}`);
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

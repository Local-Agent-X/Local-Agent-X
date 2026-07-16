import { readFileSync, mkdirSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { MIN_MAX_ITERATIONS, type LAXConfig } from "./types.js";
import { getLaxDir } from "./lax-data-dir.js";
import {
  deOneDrive,
  isCloudStoragePath,
  isCloudSyncedDir,
  localOnlyWorkspace,
  migrateWorkspace,
  ensureWorkspaceLink,
} from "./workspace/lifecycle.js";

import { createLogger } from "./logger.js";
const logger = createLogger("config");

// PROFILE_DEFAULTS moved to config-profiles.ts (config.ts is at the source-hygiene
// LOC ceiling); re-exported so existing `import { PROFILE_DEFAULTS } from "./config"`
// callers keep working.
import { PROFILE_DEFAULTS } from "./config-profiles.js";
export { PROFILE_DEFAULTS };

import { startConfigWatcher } from "./config-loader.js";
import { writeManifest, startManifestWatcher } from "./manifest-generator/index.js";

// The zod schema (field shapes, bounds, defaults — incl. the system-prompt
// default) moved to config-schema.ts, same LOC-ceiling split as config-profiles.
import { configSchema } from "./config-schema.js";

// ── Boot-time side effects (explicit) ──
// writeManifest + the two hot-reload watchers used to run AT IMPORT TIME,
// so any of config.ts's ~74 importers transitively wrote config/app-manifest.json
// and started fs watchers — unit tests couldn't import config purely, and
// standalone entrypoints (doctor, test-suite) picked up watchers they never
// wanted. Importing this module is now side-effect free; the server boot path
// (src/index.ts) calls initConfig() once, right where the import-time execution
// used to happen. Idempotent: the guard (plus each callee's own internal guard)
// makes a second call from another entrypoint a no-op.
let _initialized = false;

export function initConfig(): void {
  if (_initialized) return;
  _initialized = true;
  // Generate manifest and start watchers for hot-reload
  writeManifest();
  startConfigWatcher();
  startManifestWatcher();
}


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
  let diskRaw: Record<string, unknown> = {};
  let raw: Record<string, unknown> = {};
  let diskDirty = false;

  const applyDiskMutation = (updates: Record<string, unknown>): void => {
    Object.assign(diskRaw, updates);
    diskDirty = true;
  };
  const deleteDiskKeys = (...keys: string[]): void => {
    for (const key of keys) delete diskRaw[key];
    diskDirty = true;
  };

  if (existsSync(configPath)) {
    try {
      diskRaw = JSON.parse(readFileSync(configPath, "utf-8"));
      raw = { ...diskRaw };
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

  // Floor the per-message iteration cap. Clamp — not schema-reject — so legacy
  // config.json files with the old tiny caps (Settings default was 25) still
  // parse and boot; they just run with the modern floor. Every raw
  // config.maxIterations reader (resolve-provider fallback, handler-events,
  // autopilot) inherits this.
  if (config.maxIterations < MIN_MAX_ITERATIONS) config.maxIterations = MIN_MAX_ITERATIONS;

  // Apply profile defaults for any fields the user hasn't explicitly set
  const profileDefaults = PROFILE_DEFAULTS[config.profile];
  if (!raw.toolApproval) config.toolApproval = profileDefaults.toolApproval;
  if (!raw.retentionDays) config.retentionDays = profileDefaults.retentionDays;
  if (!raw.logLevel) config.logLevel = profileDefaults.logLevel;

  // One-time upgrade to the kernel-guarded bash default. "host" was the old
  // default; move installs still on it to "guarded" (credential dirs kernel-
  // denied at the syscall, network + ~/.config kept) exactly once. The marker
  // means a user who later picks "host" deliberately is respected and not
  // re-flipped on the next boot. Mirrors the legacy-workspace migration below.
  if (!diskRaw.sandboxModeMigrated) {
    const updates: Record<string, unknown> = { sandboxModeMigrated: true };
    if (diskRaw.sandboxMode === undefined || diskRaw.sandboxMode === "host") {
      config.sandboxMode = "guarded";
      updates.sandboxMode = "guarded";
    }
    config.sandboxModeMigrated = true;
    applyDiskMutation(updates);
  }

  // Backfill the canonical mode only when NONE is saved. An explicit
  // browserMode already on disk is honored verbatim (this block never runs for
  // it), so a user who deliberately picked isolated/continuity/advanced-shared
  // is never silently flipped to the new in-app default. For a config with no
  // browserMode: a false saved after the earlier per-session migration is a
  // genuine past shared choice and is preserved as advanced-shared; everyone
  // else (fresh install, or an unmarked legacy false) adopts the current
  // default — in-app, the embedded co-drivable browser (which falls back to
  // isolated CDP semantics when there is no desktop window/bridge).
  if (diskRaw.browserMode === undefined) {
    config.browserMode = diskRaw.browserPerSessionContext === false
      && diskRaw.browserPerSessionContextMigrated === true
      ? "advanced-shared"
      : "in-app";
    applyDiskMutation({ browserMode: config.browserMode });
  }
  if ("browserPerSessionContext" in diskRaw || "browserPerSessionContextMigrated" in diskRaw) {
    deleteDiskKeys("browserPerSessionContext", "browserPerSessionContextMigrated");
  }

  // Workspace location. The packaged desktop app sets LAX_DOCUMENTS_DIR so the
  // agent workspace lives in the user's Documents (findable in Finder/Explorer,
  // survives updates) instead of the hidden install dir that "./workspace"
  // resolves into. When the saved value is still the legacy default, move any
  // existing files over once and persist the absolute path — after that the
  // value is non-legacy and this never runs again. Dev / standalone server
  // (no LAX_DOCUMENTS_DIR) keeps "./workspace".
  const docsDir = process.env.LAX_DOCUMENTS_DIR ? deOneDrive(process.env.LAX_DOCUMENTS_DIR) : undefined;
  const legacyWorkspace = diskRaw.workspace === undefined || diskRaw.workspace === "./workspace";
  if (docsDir && !workspaceEnv && legacyWorkspace) {
    // iCloud-synced Documents (macOS) → keep the high-write workspace on
    // local-only disk instead of seeding it into a sync engine that evicts
    // files; otherwise nest under ~/Documents/Local Agent X/workspace so the
    // "Local Agent X" container mirrors the repo layout (workspace/ holds
    // apps/, images/, videos/, downloads/, …) and the cwd↔workspace junction
    // bridges two identically-named "workspace" dirs.
    const newWorkspace = isCloudSyncedDir(docsDir) ? localOnlyWorkspace() : join(docsDir, "Local Agent X", "workspace");
    migrateWorkspace(resolve(config.workspace), newWorkspace);
    config.workspace = newWorkspace;
    applyDiskMutation({ workspace: newWorkspace });
  }

  // Self-heal a workspace that was previously persisted into OneDrive (older
  // build, or a manual migration). The bad path is already saved as an
  // absolute value, so the legacy-only block above won't catch it — correct it
  // here and move the data onto the real disk.
  const diskWorkspace = typeof diskRaw.workspace === "string" ? diskRaw.workspace : "./workspace";
  const healed = deOneDrive(diskWorkspace);
  if (healed !== diskWorkspace) {
    migrateWorkspace(resolve(diskWorkspace), resolve(healed));
    if (!workspaceEnv) config.workspace = healed;
    applyDiskMutation({ workspace: healed });
  }

  // macOS analogue: self-heal a workspace persisted under a cloud-synced
  // Documents (older build, or iCloud "Desktop & Documents" switched on after
  // install) by relocating it to local-only disk. The workspace inherits the
  // sync from its parent Documents dir, so check the parent's identity as well
  // as the path itself (third-party File Providers live under CloudStorage).
  if (process.platform === "darwin") {
    const savedWorkspace = typeof diskRaw.workspace === "string" ? diskRaw.workspace : "./workspace";
    const ws = resolve(savedWorkspace);
    if (isCloudStoragePath(ws) || isCloudSyncedDir(dirname(ws))) {
      const local = localOnlyWorkspace();
      if (resolve(local) !== ws) {
        migrateWorkspace(ws, local);
        if (!workspaceEnv) config.workspace = local;
        applyDiskMutation({ workspace: local });
      }
    }
  }

  // The static file server (and a few tools) read from config.workspace, while
  // most file tools resolve agent paths against <cwd>/workspace. They MUST be
  // the same directory or generated files 404 / land where nothing serves
  // them. When the workspace was relocated off the cwd, bridge the two with a
  // junction so every reader and writer converges on one physical directory.
  ensureWorkspaceLink(config.workspace);

  // Inject actual app URL into system prompt (works with any port)
  const appUrl = `http://127.0.0.1:${config.port}`;
  config.systemPrompt = config.systemPrompt.replace(/\{\{APP_URL\}\}/g, appUrl);

  // Auto-generate auth token if missing
  if (!config.authToken) {
    config.authToken = generateAuthToken();
    applyDiskMutation({ authToken: config.authToken });
    logger.info("[config] Generated new auth token (see ~/.lax/config.json)");
  }

  if (diskDirty) writeConfigFile(diskRaw);

  return config;
}

function writeConfigFile(config: object): void {
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

export function saveConfig(config: LAXConfig): void {
  writeConfigFile(config);
}

export function getAuthPath(): string {
  return join(getConfigDir(), "auth.json");
}

// Where web/mobile attachments land (~/.lax/uploads). The HTTP upload route and
// the chat request pipeline both write here; resolveAgentPath maps a
// "/uploads/<file>" reference back to this dir so file tools can open them.
export function uploadsDir(): string {
  return join(getLaxDir(), "uploads");
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

// Canonical workspace-root resolver — the single source of truth for where the
// agent's files live (~/Documents/Local Agent X/workspace in the packaged app).
// App builds, app discovery, and the static file server MUST resolve through
// this, NOT cwd-relative resolve("workspace"), which only lands in the right
// place when the cwd↔workspace junction happens to be intact. Generated apps
// and media write here and the server serves from here, so they always agree
// regardless of which directory the process was launched from.
export function workspaceRoot(): string {
  return resolve(getRuntimeConfig().workspace);
}

// Resolve a path inside the workspace, preserving its internal structure
// (e.g. workspacePath("apps", name) → <workspace>/apps/<name>). Never flattens.
export function workspacePath(...segments: string[]): string {
  return resolve(workspaceRoot(), ...segments);
}

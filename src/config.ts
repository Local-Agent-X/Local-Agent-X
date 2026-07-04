import { z } from "zod";
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
  /** Max chat turns the canonical-loop runs at once across all sessions
   *  (interactive lane cap). Each session still serializes its own turns via
   *  the inject queue; this only governs cross-session parallelism. */
  maxInteractiveSessions: z.number().int().min(1).max(20).default(10),
  /** Max sub-agents (agent_spawn) running concurrently — the `agent` lane
   *  cap. Each is a full agent loop + provider stream + tool subprocesses, so
   *  the heavy local cost scales with this. User-tunable from Settings. */
  maxSubAgents: z.number().int().min(1).max(20).default(5),
  /** GLOBAL stampede ceiling on total in-flight workers across ALL lanes
   *  (scheduler.ts pumpScheduler) — caps the ~19 sum-of-per-lane-caps down to
   *  12. Sits ABOVE the per-lane maxes (interactive 10, agent 5) so normal
   *  per-lane usage is NOT throttled — it only bounds a runaway fan-out. The
   *  "start fan-out at 4" policy is enforced later on the fan-out launcher, not
   *  here. Intended production default is cores−2 auto-scaling (a follow-up). */
  maxConcurrentAgents: z.number().int().min(1).max(12).default(12),
  /** Max auto-build chunks built in PARALLEL within a single orchestration
   *  (S3). Default 1 = the serial per-chunk loop, byte-identical to pre-S3
   *  behaviour. When >1, disjoint chunks in a conflict-graph wave build
   *  concurrently in isolated git worktrees and merge back STRICTLY SERIALLY.
   *  Clamped to [1,12]; 12 = agency MAX_CONCURRENT_WORKTREES, and the
   *  scheduler's agent-lane cap throttles the underlying workers further. */
  maxConcurrentChunks: z.number().int().min(1).max(12).default(1),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  profile: z.enum(["home", "dev", "enterprise"]).default("home"),
  toolApproval: z.enum(["auto", "confirm-risky", "confirm-all"]).default("auto"),
  retentionDays: z.number().int().min(7).max(365).default(90),
  autoUpdate: z.boolean().default(true),
  logLevel: z.enum(["basic", "detailed", "full-audit"]).default("basic"),
  /** Bash sandbox mode. "guarded" (default, macOS/Linux) runs bash under a
   *  kernel cage that denies reads/writes of credential dirs (~/.ssh, ~/.aws, …)
   *  at the syscall — backstopping the command parser's $VAR/$(...) blind spot —
   *  while keeping network and ~/.config so npm/git/gh keep working; falls back
   *  to "host" where no kernel backend exists. "host" runs commands directly on
   *  the host OS with no kernel cage (full functionality, parser-only guard).
   *  "docker" runs commands inside a network-isolated Alpine container — opt-in
   *  for paranoid setups; breaks host-OS commands and network access. "seatbelt"
   *  (macOS) / "bwrap" (Linux) are the STRICT kernel cage — same credential deny
   *  PLUS all-network deny and ~/.config deny. Toggleable from Settings → Security. */
  sandboxMode: z.enum(["host", "guarded", "docker", "seatbelt", "bwrap"]).default("guarded"),
  /** One-time marker: the "host"→"guarded" default upgrade has run. Lets the
   *  migration upgrade installs still on the OLD "host" default exactly once,
   *  without re-flipping a user who later picks "host" deliberately. */
  sandboxModeMigrated: z.boolean().default(false),

  /** Whole-server kernel confinement (phase B). When true, the entry point
   *  re-execs the ENTIRE server under seatbelt (macOS) / bwrap (Linux):
   *  network stays allowed but sensitive home dirs (~/.ssh, ~/.aws, …) become
   *  kernel-unreadable and persistence vectors unwritable for the server AND
   *  every child it spawns. Off by default; a boot-failure escape hatch falls
   *  back to unconfined after 2 confined boots that never reach listening
   *  (see sandbox/server-confine.ts). Env override: LAX_SERVER_SANDBOX=1/0. */
  serverSandbox: z.boolean().default(false),

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
  // Computer control (mouse/keyboard via the `computer` tool) is the one
  // category that defaults OFF — it can drive the whole machine, so it's an
  // explicit opt-in (Settings → Security), gated further by the OS permission.
  enableComputerControl: z.boolean().default(false),
  // Remote control from a paired phone over the live screen. Separate switch from
  // enableComputerControl (that gates the AGENT) — this gates the human operator
  // driving from mobile. Same risk profile: DEFAULT OFF, also needs the OS grant.
  enableRemoteControl: z.boolean().default(false),

  /** Opt-in USD spend caps on REAL per-call API spend. 0 = disabled (default).
   *  When > 0, the spend-cap rule pack blocks every tool call once the matching
   *  billable spend reaches the budget — dailyBudgetUsd against today's,
   *  sessionBudgetUsd against the active session's. Flat-rate subscription
   *  (Claude CLI / SuperGrok / ChatGPT) usage is not billed and never capped.
   *  Not security kill-switches, so they're user-flippable in interactive
   *  sessions (not protected). */
  dailyBudgetUsd: z.number().min(0).default(0),
  sessionBudgetUsd: z.number().min(0).default(0),
  /** Per-model daily USD caps on real per-call API spend, keyed by model id.
   *  A model over its cap is blocked for the rest of the day. Subscription
   *  (flat-rate) models are never billable, so they're never capped here. */
  modelDailyBudgetsUsd: z.record(z.number().min(0)).default({}),
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
  if (raw.autoUpdate === undefined) config.autoUpdate = profileDefaults.autoUpdate;
  if (!raw.logLevel) config.logLevel = profileDefaults.logLevel;

  // One-time upgrade to the kernel-guarded bash default. "host" was the old
  // default; move installs still on it to "guarded" (credential dirs kernel-
  // denied at the syscall, network + ~/.config kept) exactly once. The marker
  // means a user who later picks "host" deliberately is respected and not
  // re-flipped on the next boot. Mirrors the legacy-workspace migration below.
  if (!raw.sandboxModeMigrated) {
    if (raw.sandboxMode === undefined || raw.sandboxMode === "host") {
      config.sandboxMode = "guarded";
    }
    config.sandboxModeMigrated = true;
    saveConfig(config);
  }

  // Workspace location. The packaged desktop app sets LAX_DOCUMENTS_DIR so the
  // agent workspace lives in the user's Documents (findable in Finder/Explorer,
  // survives updates) instead of the hidden install dir that "./workspace"
  // resolves into. When the saved value is still the legacy default, move any
  // existing files over once and persist the absolute path — after that the
  // value is non-legacy and this never runs again. Dev / standalone server
  // (no LAX_DOCUMENTS_DIR) keeps "./workspace".
  const docsDir = process.env.LAX_DOCUMENTS_DIR ? deOneDrive(process.env.LAX_DOCUMENTS_DIR) : undefined;
  const legacyWorkspace = raw.workspace === undefined || raw.workspace === "./workspace";
  if (docsDir && legacyWorkspace) {
    // iCloud-synced Documents (macOS) → keep the high-write workspace on
    // local-only disk instead of seeding it into a sync engine that evicts
    // files; otherwise nest under ~/Documents/Local Agent X/workspace so the
    // "Local Agent X" container mirrors the repo layout (workspace/ holds
    // apps/, images/, videos/, downloads/, …) and the cwd↔workspace junction
    // bridges two identically-named "workspace" dirs.
    const newWorkspace = isCloudSyncedDir(docsDir) ? localOnlyWorkspace() : join(docsDir, "Local Agent X", "workspace");
    migrateWorkspace(resolve(config.workspace), newWorkspace);
    config.workspace = newWorkspace;
    saveConfig(config);
  }

  // Self-heal a workspace that was previously persisted into OneDrive (older
  // build, or a manual migration). The bad path is already saved as an
  // absolute value, so the legacy-only block above won't catch it — correct it
  // here and move the data onto the real disk.
  const healed = deOneDrive(config.workspace);
  if (healed !== config.workspace) {
    migrateWorkspace(resolve(config.workspace), resolve(healed));
    config.workspace = healed;
    saveConfig(config);
  }

  // macOS analogue: self-heal a workspace persisted under a cloud-synced
  // Documents (older build, or iCloud "Desktop & Documents" switched on after
  // install) by relocating it to local-only disk. The workspace inherits the
  // sync from its parent Documents dir, so check the parent's identity as well
  // as the path itself (third-party File Providers live under CloudStorage).
  if (process.platform === "darwin") {
    const ws = resolve(config.workspace);
    if (isCloudStoragePath(ws) || isCloudSyncedDir(dirname(ws))) {
      const local = localOnlyWorkspace();
      if (resolve(local) !== ws) {
        migrateWorkspace(ws, local);
        config.workspace = local;
        saveConfig(config);
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

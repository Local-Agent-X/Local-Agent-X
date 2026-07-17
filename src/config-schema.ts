// The zod schema for config.json — moved out of config.ts (config.ts is at the
// source-hygiene LOC ceiling; same split pattern as config-profiles.ts). Owns
// every field's shape, bounds, and default; config.ts owns load/save/migrate.
import { z } from "zod";
import { loadSystemPrompt } from "./config-loader.js";

// System prompt is loaded from config/system-prompt.md (agent-editable safe zone).
// Falls back to a minimal prompt if the file is missing.
const DEFAULT_SYSTEM_PROMPT = loadSystemPrompt() || "You are a personal AI companion running inside Local Agent X. Use your tools to help the user.";

export const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7007),
  authToken: z.string().default(""),
  workspace: z.string().min(1).default("./workspace"),
  openaiApiKey: z.string().optional(),
  model: z.string().default("grok-4.5"),
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
   *  PLUS all-network deny and ~/.config deny. Settings exposes guarded/host/
   *  docker; select these strict native modes through env or config. */
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

  // Explicit browser identity posture. The agent always uses a dedicated
  // profile and never touches the user's normal browser profile. Default is
  // in-app: the embedded, co-drivable WebContentsView browser (Waves 0-3).
  // When the run has no desktop window/bridge (headless, CI, soak), in-app
  // falls back to the CDP BrowserManager with isolated (ephemeral-per-session)
  // semantics — see runtime.acquireSessionContext.
  // Continuity persists one dedicated agent identity across sessions; isolated
  // (fresh disposable context) is a per-task opt-in for untrusted or
  // privacy-sensitive work; advanced-shared is the explicit high-risk mode.
  browserMode: z.enum(["isolated", "continuity", "advanced-shared", "in-app"]).default("in-app"),

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
  // Supervised browser mode. DEFAULT OFF: the in-app browser is autonomous by
  // default, so browser.evaluate runs without a prompt. Turning this ON is the
  // opt-in that restores confirm-on-evaluate — except on the general trusted-
  // origin allowlist (src/browser/trusted-origins.ts), where automations that
  // drive social/composer sites stay unattended. Nobody turns autonomy on;
  // supervision is the switch.
  supervisedBrowser: z.boolean().default(false),
  // UI event bus: lets user-interface activity (in-app browser navigation,
  // page titles — hosts/paths only, values and credentials are redacted at
  // the store) surface as a short digest in the agent's context. Default ON —
  // deliberate product decision: browser-only events, redaction enforced in
  // src/orchestrator/ui-event-store.ts, visible opt-out in Settings → Security.
  enableUiEventBus: z.boolean().default(true),
  // Remote control from a paired phone over the live screen. Separate switch from
  // enableComputerControl (that gates the AGENT) — this gates the human operator
  // driving from mobile. Same risk profile: DEFAULT OFF, also needs the OS grant.
  enableRemoteControl: z.boolean().default(false),
  localOnlyMode: z.boolean().default(false),

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

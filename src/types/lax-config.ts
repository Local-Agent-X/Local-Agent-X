// Config-domain types (LAXConfig + deployment profiles) — split out of
// ../types.ts to keep it under the 400-LOC cap, same pattern as
// server-events.ts. Re-exported from ../types.ts so existing
// `from "...types.js"` imports are unchanged.
import type { SandboxMode } from "../sandbox/types.js";

// ── Deployment Profile Types ──

export type DeploymentProfile = "home" | "dev" | "enterprise";
export type BrowserMode = "isolated" | "continuity" | "advanced-shared";

export interface ProfileDefaults {
  sandboxMode: SandboxMode;
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  networkExposure: "localhost" | "lan" | "public";
  logLevel: "basic" | "detailed" | "full-audit";
}

// ── Config Types ──

/** Floor for the user-tunable per-message iteration cap. Legacy installs saved
 *  tiny caps (the old Settings input defaulted to 25 with max=100), which cut
 *  long agentic runs off mid-task. Loaders CLAMP up to this instead of
 *  rejecting, so old config/settings files still boot; the Settings route
 *  refuses new writes below it. Purpose-specific internal budgets (voice,
 *  background jobs, sub-agent ops) are deliberately NOT floored. */
export const MIN_MAX_ITERATIONS = 120;

export interface LAXConfig {
  port: number;
  authToken: string;
  workspace: string;
  openaiApiKey?: string;
  model: string;
  maxIterations: number;
  temperature: number;
  /** Interactive lane concurrency cap — how many chat turns run at once
   *  across all sessions. See scheduler.ts laneCap(). */
  maxInteractiveSessions: number;
  /** Agent lane concurrency cap — how many sub-agents run at once. See scheduler.ts laneCap(). */
  maxSubAgents: number;
  /** Global stampede ceiling on in-flight workers across ALL lanes (default 12). See scheduler pumpScheduler(). */
  maxConcurrentAgents: number;
  /** Max auto-build chunks built in parallel per orchestration; default 1 = serial. See config.ts + loop/parallel-waves.ts. */
  maxConcurrentChunks: number;
  systemPrompt: string;
  profile: DeploymentProfile;
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  logLevel: "basic" | "detailed" | "full-audit";
  sandboxMode: SandboxMode;
  /** Whole-server kernel confinement (seatbelt/bwrap re-exec at boot).
   *  Off by default; see sandbox/server-confine.ts. */
  serverSandbox: boolean;
  ariRequired?: boolean;

  // ── Externalized service URLs ──
  ollamaUrl: string;
  /** Ollama Cloud (Turbo) endpoint. Empty disables cloud routing. Pairs
   *  with the OLLAMA_CLOUD_API_KEY secret to merge cloud models into the
   *  Ollama provider's picker and route per-model at chat dispatch. */
  ollamaCloudUrl: string;
  sdServerUrl: string;
  videoServerUrl: string;
  xttsServerUrl: string;

  /** Browser identity posture. Isolated is ephemeral per session; continuity
   *  persists one dedicated agent identity with single-session ownership;
   *  advanced-shared explicitly shares one live context across sessions. */
  browserMode: BrowserMode;

  // ── Externalized limits & timeouts ──
  browserCdpPort: number;
  browserIdleTimeoutMs: number;
  rateLimitMax: number;
  rateLimitRefillPerSec: number;
  maxRequestBodyBytes: number;
  maxUploadBytes: number;
  maxAudioBytes: number;
  authMaxFailures: number;
  authLockoutMs: number;
  agentTimeoutMs: number;
  maxCachedSessions: number;

  /** When true (default), voice mode exposes the `voice_visual` tool to
   *  the LLM so it can morph the particle sphere into emojis/text/shapes/
   *  moods during emotionally significant moments. Off = strict no-tools
   *  voice mode (existing behavior). Hot-reloads via the config watcher. */
  voice_visuals_enabled?: boolean;

  /** Preferred voice engine for Telegram/WhatsApp bridge replies. The bridge
   *  TTS chain tries the preferred engine first, then falls back through the
   *  others so a missing/unhealthy preference doesn't silence the bridge.
   *  - "auto"       — clones first (sovits→chatterbox), then lite kokoro
   *  - "sovits"     — fine-tuned clone (best when trained weights exist)
   *  - "chatterbox" — zero-shot reference-clip clone
   *  - "lite"       — built-in kokoro voice (fastest, no clone needed)
   *  - "xai"        — xAI Grok TTS via SuperGrok / X Premium+ OAuth (remote,
   *                   slower than local sidecars, included with subscription) */
  bridgeVoicePreference?: "auto" | "sovits" | "chatterbox" | "lite" | "xai";

  /** Category-level tool toggles surfaced as the Tool Policy switches in
   *  Settings → Security. Default-on. When false, every tool in the
   *  category is blocked at pre-dispatch with stage "tool-policy". These
   *  are the simple per-user kill-switches that sit OVER the granular
   *  tool-policy rule engine — separate from per-tool rules so the user
   *  can disable an entire surface area without learning the rule DSL. */
  enableShell: boolean;
  enableHttp: boolean;
  enableBrowser: boolean;
  /** Computer-control kill-switch (mouse/keyboard via the `computer` tool).
   *  DEFAULT OFF — high-risk opt-in. When false, every `computer` call is
   *  blocked at pre-dispatch. The panic hotkey flips this off. */
  enableComputerControl: boolean;
  /** Remote-control kill-switch (phone driving mouse/keyboard over the live
   *  screen). DEFAULT OFF — high-risk opt-in, separate from the agent's
   *  enableComputerControl. When false, the live-screen session drops every
   *  rtc_input. The panic hotkey flips this off too. */
  enableRemoteControl: boolean;

  /** Opt-in daily USD spend cap. 0 (default) = disabled. When > 0, the
   *  spend-cap pack blocks every tool call once today's total cost reaches
   *  this budget. Not a security kill-switch; user-flippable. */
  dailyBudgetUsd: number;
  /** Opt-in per-session USD spend cap. 0 (default) = disabled. When > 0, the
   *  spend-cap pack blocks every tool call once the active session's cost
   *  reaches this budget. Not a security kill-switch; user-flippable. */
  sessionBudgetUsd: number;
  /** Per-model daily USD caps on real per-call API spend, keyed by model id.
   *  Subscription (flat-rate) models are never billable, so never capped. */
  modelDailyBudgetsUsd: Record<string, number>;
}

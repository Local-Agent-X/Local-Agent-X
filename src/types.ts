import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Agent Types ──

/**
 * Audience = the consumer context that decides which tools are visible.
 * Canonical resolver in src/tool-search.ts reads `audiences` on each
 * ToolDefinition to build the per-request tool list. The audience-tool
 * mapping is owned by src/tools/audience-map.ts.
 */
export type Audience =
  | "main-chat"      // top-level user-facing chat (Primal)
  | "spawned-agent"  // sub-agents spawned via agent_spawn (default)
  | "operator"       // Operations-phase workers (browser + file + memory)
  | "build-intent";  // strip-down used when main-chat detects build intent

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  /** Tool only reads state, never mutates. Eligible for parallel batching. */
  readOnly?: boolean;
  /** Explicit opt-in to parallel execution alongside adjacent concurrent-safe tools. */
  concurrencySafe?: boolean;
  /** Audiences that see this tool eagerly. Unset/empty = deferred (only via tool_search). */
  audiences?: Audience[];
}

/**
 * Tool result envelope (lightweight).
 *
 * Why: the original `{ content, isError? }` collapsed every outcome into
 * a binary. The model couldn't distinguish "command ran cleanly with no
 * stdout" from "killed by policy" from "still running async." Result:
 * 47-call retry loops where empty looked like uncertain.
 *
 * The fix is a single optional discriminator — `status` — for the four
 * non-default outcomes that change how the model should react. Everything
 * else (recovery hints, timing, exit codes) lives in `metadata` so the
 * envelope stays thin and authors don't need to learn five new fields.
 *
 * Status values:
 *   ok       — completed (default; inferred when status omitted).
 *              `content` is the output, may be "".
 *   error    — definite failure (default for isError: true).
 *   blocked  — refused by policy/safety. Retrying the same call WILL fail.
 *              The model should pivot. Recommend a `recovery` hint in
 *              metadata (e.g. "use http_request instead of bash curl").
 *   timeout  — runtime deadline expired. Distinct from error because work
 *              may have partially landed; metadata.partial_output captures
 *              what was produced before the kill.
 *   running  — async session was started; `session_id` is the handle.
 *              The model must poll, not wait.
 *
 * 95% of tools just call `ok(s)` / `err(s)` and never see this enum.
 * Tools that need the new states opt in by setting `status`.
 */
export type ToolResultStatus = "ok" | "error" | "blocked" | "timeout" | "running";

export interface ToolResult {
  /**
   * Output payload. May be "" when the call ran but produced no captured
   * output (ConPTY-only progress on Windows, etc.). Empty content with
   * `status: "ok"` is meaningful — the model should NOT retry.
   */
  content: string;
  /**
   * Legacy binary failure flag. The dispatcher derives:
   *   isError === true  → status "error"
   *   isError !== true  → status "ok"
   * New code should set `status` directly; this field stays for the ~60
   * existing tools that already use it.
   */
  isError?: boolean;

  /**
   * Optional outcome discriminator. When unset, derived from `isError`.
   * Set this only when the tool needs to express blocked/timeout/running
   * — the four non-default cases that change the model's next move.
   */
  status?: ToolResultStatus;

  /**
   * Handle for `status: "running"`. The receiving model polls a status
   * tool with this id rather than waiting on the original call. Tools
   * returning `running` MUST set `content` to a brief poll hint
   * ("started; poll process_status with session_id=<id>") so a model
   * that ignores `status` still has a usable instruction.
   */
  session_id?: string;

  /**
   * Free-form metadata bag. Conventional keys (callers should use these
   * names so the renderer can emit a consistent header):
   *   duration_ms: number  — wall-clock time the call took
   *   exit_code:   number  — for subprocess tools
   *   recovery:    string  — suggested next move on blocked/timeout
   *                          ("use http_request", "split the call", ...)
   *   stderr:      string  — separate-stream output for subprocesses
   *   partial_output: string — content captured before a timeout kill
   *   truncated:   boolean — content was cut for context safety
   *   bytes:       number  — full payload size when truncated
   */
  metadata?: Record<string, unknown>;
}

export interface AgentTurn {
  messages: ChatCompletionMessageParam[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  stopReason: "end_turn" | "max_iterations" | "abort" | "error";
  /** When stopReason is "error", the provider's error message — used by the
   * chat route to decide whether the error is transient (rate limit, auth,
   * overload) and eligible for failover to another provider. */
  errorMessage?: string;
}

// ── Security Types ──

export interface SecurityDecision {
  allowed: boolean;
  /** Technical reason — for logs, audit, and developer debug. */
  reason: string;
  /**
   * Plain-English summary the model surfaces to the user. Optional so legacy
   * block sites still compile; the formatter falls back to `reason` when
   * absent. Convention: one line, no jargon, names what was attempted in user
   * terms, offers 1-2 next steps the user can take. Use the canonical
   * templates in `USER_HINTS` instead of writing per-site sentences — pair
   * with the "translate tool failures, never parrot" prompt rule.
   */
  userHint?: string;
  quarantined?: boolean;
}

/**
 * Static, English-only user-facing hints for blocked-tool responses. Each
 * category collapses many block sites into one sentence so the model surfaces
 * a consistent message regardless of which underlying rule fired. Block sites
 * import the matching key — they MUST NOT invent per-site prose.
 */
export const USER_HINTS = {
  /** SSRF, egress allowlist, invalid URL, threat-elevated external, data lineage taint. */
  network:
    "I can't reach that URL or network address right now — want me to skip it, use a local file, or try a different address?",
  /** Path traversal, workspace boundary, file-access-mode restrictions. */
  fileSystem:
    "I can't access that file path — try a path inside the project or your usual user folders, or broaden file access in Settings.",
  /** Sensitive credential files AND protected platform/engine sources. */
  secrets:
    "I can't touch credential files or platform internals — give me a different path, or you'll need to edit that file yourself.",
  /** Delegated agent + source-code write/edit/bash without a sandbox. */
  worktreeIsolation:
    "I can't safely change source code from a delegated agent without an isolated sandbox — let me run this directly instead.",
  /** Tool-policy default-deny, rate cap by policy, blocked args, host allowlist, hook, RBAC, declined approval, context-restricted tool. */
  policy:
    "That action isn't permitted by the current policy — tell me what you'd like instead, or relax the rule in ~/.lax/tool-policy.json.",
  /** Shell metacharacters, heredoc + script writes, dangerous patterns, obfuscation. */
  commandShell:
    "I can't run that shell command — tell me what you're trying to do and I'll find a safer way (often a dedicated tool exists).",
  /** Plan mode is on — only read-only tools allowed. */
  planMode:
    "I'm in plan mode and can only read right now — say \"exit plan mode\" when you want me to start making changes.",
  /** Threat engine fired on tool result — needs `/approve` to continue. */
  threatConsent:
    "Something tripped a safety check — type `/approve <one-line reason>` if this is a legitimate request, or tell me a different approach.",
  /** Circuit breaker, per-tool rate limit, autopilot self-edit ceiling. */
  retryExhausted:
    "I've tried this several times and it keeps being denied — let's switch approaches; what should we do instead?",
} as const;

export type UserHintKey = keyof typeof USER_HINTS;

// ── Session Types ──

/**
 * Compacted system messages start with this marker so the on-disk format
 * (a `summary` row in the session jsonl) and the in-memory format (a
 * leading `system` message in `Session.messages`) can be round-tripped
 * cleanly. Used by `writeSessionLog` to detect a compaction-summary
 * leading message and emit it as a `summary` row instead of a `msg` row,
 * and by `prepareAgentRequest` to recognise a session as compacted
 * without a separate field.
 */
export const COMPACTION_PREFIX = "[COMPACTED CONTEXT —";

export interface Session {
  id: string;
  title: string;
  messages: ChatCompletionMessageParam[];
  createdAt: number;
  updatedAt: number;
  /** Session ID this session was forked from */
  forkedFrom?: string;
  /** Message index at which the fork was taken */
  forkAtIndex?: number;
  /**
   * Compaction lives as a leading `{role:"system", content:"[COMPACTED CONTEXT — …]"}`
   * entry in `messages` (round-tripped through a `summary` row in the
   * jsonl log). `compactedSummary` / `compactedAt` no longer exist as
   * top-level fields — code should check `messages[0]?.role === "system" &&
   * messages[0].content.startsWith(COMPACTION_PREFIX)` to detect it.
   */
}

// ── Server Types ──

/**
 * Structured chip a tool can attach to its result so the UI renders an
 * out-of-band affordance (badge + optional action button) in the agent
 * panel. The chip carries machine identifiers (op ids) the model never
 * sees in its text channel — preventing the "model parrots its host op
 * id back as a fake delegation" failure mode.
 *
 * Tools emit a chip by including `metadata.chip: ToolChip` on their
 * `ToolResult`. The executor harvests it and emits a `tool_chip`
 * `ServerEvent` alongside the normal `tool_end`. The chat dispatcher
 * forwards both to SSE/WS; the client renders the chip below the
 * matching tool card.
 */
export interface ToolChip {
  /** Discriminator. Today: "blocked-by-op". Add new kinds as new affordances. */
  kind: "blocked-by-op";
  /** Short human label rendered on the chip ("Prior op in flight"). */
  label: string;
  /** Optional one-line subtitle ("yes import them"). Truncated by UI. */
  detail?: string;
  /**
   * Op id this chip refers to. **Server-side only** — used by client to
   * wire the kill-button to the right op. The model never receives the
   * chip event; it stays in the `onEvent` channel that flows to the UI.
   */
  opId?: string;
  /** Optional action buttons. UI renders one button per entry. */
  actions?: Array<{ label: string; tool: string; args?: Record<string, unknown> }>;
}

/**
 * Structured preview of an action awaiting approval. Discriminated by `kind`
 * so the UI can render an appropriate card (diff view, command box, etc.)
 * instead of the raw `argsPreview` JSON blob. Built by the preview factories
 * in approval-manager.ts and attached to the `approval_requested` event.
 */
export type ActionPreview =
  | { kind: "file"; path: string; diff: string; lineCount: { added: number; removed: number }; truncated: boolean }
  | { kind: "shell"; cmd: string; cwd: string; explanation?: string }
  | { kind: "network"; method: string; url: string; bodyPreview: string; bodyTruncated: boolean; domain: string }
  | { kind: "money"; amount: number; currency: string; recipient: string; source: string; formatted: string };

export type ServerEvent =
  | { type: "stream"; delta: string }
  /** Adapter-initiated stream replacement (tool-call-from-text extraction
   *  in openai-compat). Client swaps the bubble's text with `text` instead
   *  of appending. `delta` is omitted on this variant. */
  | { type: "stream"; replace: true; text: string }
  | { type: "tool_start"; toolName: string; toolCallId?: string; args: unknown; riskLevel?: "low" | "medium" | "high"; context?: string; requiresApproval?: boolean }
  | { type: "tool_progress"; toolName: string; toolCallId?: string; message: string }
  | { type: "tool_end"; toolName: string; toolCallId?: string; result: string; allowed: boolean }
  | { type: "done"; usage: AgentTurn["usage"] }
  // Out-of-band notice that the turn stopped early (middleware abort,
  // wall-clock ceiling, stale evidence, loop detection, etc.). The UI
  // renders this as a small inline note BELOW the message, NOT as
  // appended message body — keeps technical jargon out of chat content
  // and out of persisted message history. `reason` is the user-friendly
  // one-liner; `debug` is the original technical text for diagnostics.
  | { type: "stopped"; reason: string; debug?: string; firedBy?: string }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string }
  | { type: "secrets_request"; secrets: Array<{ name: string; service?: string; reason: string }> }
  | { type: "approval_requested"; approvalId: string; toolName: string; toolCallId?: string; context: string; argsPreview: string; preview?: ActionPreview }
  | { type: "approval_timeout"; approvalId: string; toolName: string; toolCallId?: string }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean }
  | { type: "visual"; kind: "emoji" | "text" | "shape" | "mood"; value: string; durationMs: number }
  | { type: "bg_op_queued"; opId: string; task: string; provider: string; lane: string; queuePosition: number }
  | { type: "bg_op_queue_reordered"; opId: string; queuePosition: number }
  | { type: "bg_op_started"; opId: string; task: string; provider: string }
  | { type: "bg_op_progress"; opId: string; line: string }
  | { type: "bg_op_completed"; opId: string; status: "completed" | "failed" | "cancelled"; summary: string; filesChanged: string[]; metadata?: Record<string, unknown>; resultUrl?: string }
  | { type: "bg_op_nudge"; opIds: string[]; text: string }
  // Antivirus interference detected. Bash tool detected ≥3 powershell
  // processes killed mid-stream within 60s — the AV-behavior-shield
  // signature. UI renders as a sticky banner with a one-time message
  // pointing at the project path the user should whitelist. Emitted
  // ONCE per server uptime so we don't spam.
  | { type: "av_blocked_warning"; platform: string; projectPath: string; message: string }
  // Worker narration → main chat thread (Step 1 of JARVIS-mode roadmap).
  // The worker's own LLM text deltas, surfaced as a distinct message bubble
  // in chat (not just the sidebar progress trace) so the user sees what the
  // worker is doing in real-time, conversationally. opId scopes the bubble
  // — multiple workers each get their own bubble, identified + styled
  // separately from the main agent's stream.
  | { type: "worker_stream"; opId: string; task?: string; delta: string }
  | { type: "worker_done"; opId: string; status: "completed" | "failed" | "cancelled"; summary?: string }
  // Canonical chat lifecycle: emitted at the START of a chat turn so the UI
  // can track the opId for reconnect/cancel. After connection drops, the
  // client sends `{type:"reconnect_op", opId}` over WS and the server
  // replays missed canonical events via `reconnectOp(opId, sinceSeq)`.
  // Stop button → `{type:"cancel_op", opId}` → `opCancel(opId)`.
  | { type: "chat_op_started"; opId: string }
  // Out-of-band UI hint emitted by tools that want to surface a structured
  // affordance (op id, kill button, blocked reason) WITHOUT putting that
  // info in the model-visible result text. Originally added so BLOCKED
  // op_submit_async / self_edit results could carry the live op id to the
  // agent panel as a chip while the model never sees the id (and therefore
  // can't parrot it back as a fake delegation message — see
  // tests/op-submit-async-self-block.test.ts).
  | { type: "tool_chip"; toolCallId?: string; chip: ToolChip };

// ── Auth Types ──

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // Captured from the OAuth response when present. Used to mirror
  // credentials into ~/.codex/auth.json so a single LAX sign-in
  // covers the Codex CLI subprocess too (build_app, primal-build,
  // etc.). Optional because pre-bridge installs don't have them on
  // disk yet — the next token refresh repopulates.
  idToken?: string;
  accountId?: string;
}

// ── Deployment Profile Types ──

export type DeploymentProfile = "home" | "dev" | "enterprise";

export interface ProfileDefaults {
  sandboxMode: "host" | "docker";
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  networkExposure: "localhost" | "lan" | "public";
  logLevel: "basic" | "detailed" | "full-audit";
}

// ── Config Types ──

export interface LAXConfig {
  port: number;
  authToken: string;
  workspace: string;
  openaiApiKey?: string;
  model: string;
  maxIterations: number;
  temperature: number;
  systemPrompt: string;
  profile: DeploymentProfile;
  toolApproval: "auto" | "confirm-risky" | "confirm-all";
  retentionDays: number;
  autoUpdate: boolean;
  logLevel: "basic" | "detailed" | "full-audit";
  sandboxMode: "host" | "docker";
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

  /** Browser session mode. "isolated" = dedicated agent profile (safer).
   *  "attach" = your real Chrome profile, requires Chrome closed. */
  browserMode: "isolated" | "attach";

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
}

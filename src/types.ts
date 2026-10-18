import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

// ── Agent Types ──

/**
 * Audience = the consumer context that decides which tools are visible.
 * Canonical resolver in src/tools/tool-search.ts reads `audiences` on each
 * ToolDefinition to build the per-request tool list. The audience-tool
 * mapping is owned by src/tools/audience-map.ts.
 */
export type Audience =
  | "main-chat"      // top-level user-facing chat (the main agent)
  | "spawned-agent"  // sub-agents spawned via agent_spawn (default)
  | "operator";      // Operations-phase workers (browser + file + memory)

export type ToolEffectClass =
  | "read-only"
  | "idempotent-mutation"
  | "keyed-mutation"
  | "non-idempotent";

export interface ToolEffect {
  class: ToolEffectClass;
  /** Stable caller-supplied key reused unchanged on every retry. */
  operationKey?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Tier-compact description for medium/weak models: one or two sentences (what it
   * does, the one rule that matters, an example call when arguments are non-obvious),
   * at most 220 chars. Must keep every safety rule the full text carries. Absent =
   * the tier falls back to `description` (medium) or first-sentence truncation (weak),
   * so a missing compact text never degrades a tool. Applied by shrinkToolsForTier.
   */
  compactDescription?: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
  /** Side-effect semantics used by automatic tool retry. Unset is non-idempotent. */
  effect?: ToolEffect | ((args: Record<string, unknown>) => ToolEffect);
  /** Tool only reads state, never mutates. Eligible for parallel batching. */
  readOnly?: boolean;
  /** Explicit opt-in to parallel execution alongside adjacent concurrent-safe tools. */
  concurrencySafe?: boolean;
  /** Audiences that see this tool eagerly. Unset/empty = deferred (only via tool_search). */
  audiences?: Audience[];
  /**
   * Runtime availability gate. Returns false when this tool CANNOT work on this
   * machine right now (e.g. email_send with no SMTP configured), so it is
   * withheld from both the per-request tool set and the deferred-tool manifest
   * rather than advertised as a capability that will only ever error.
   *
   * ABSENT MEANS AVAILABLE — always. So does a predicate that throws, and so
   * does any non-`false` return. Hiding a tool that actually works is invisible
   * to everyone (no error, no log — the agent just can't do something) and is
   * strictly worse than advertising a tool that fails with a clear message, so
   * every ambiguity resolves toward "available". Evaluated per request per tool
   * by isToolAvailable() in src/tools/tool-search.ts; keep it cheap and
   * side-effect free. Declare it on the tool, next to the tool — there is no
   * central name→predicate table.
   */
  available?: () => boolean;
  confirmWithUser?: (args: Record<string, unknown>, ctx: { userText: string }) => string | null; // why THIS call needs the user's OK (ask-user-gates.ts)
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
 *   declined — the user was asked for approval and said no to THIS call.
 *              Distinct from blocked: the tool works and policy doesn't
 *              forbid it forever — a human just refused this specific
 *              action. The model should adjust the approach or ask the
 *              user; it must not immediately retry the identical call and
 *              must NEVER conclude the tool is broken. If the user then
 *              says to proceed, requesting approval again is legitimate.
 *              Produced ONLY by the
 *              user-decline branch of the approval phase (an absent human
 *              in an unattended run is `blocked`, not `declined`).
 *   timeout  — runtime deadline expired. Distinct from error because work
 *              may have partially landed; metadata.partial_output captures
 *              what was produced before the kill.
 *   running  — async session was started; `session_id` is the handle.
 *              The model must poll, not wait.
 *
 * 95% of tools just call `ok(s)` / `err(s)` and never see this enum.
 * Tools that need the new states opt in by setting `status`.
 */
export type ToolResultStatus = "ok" | "error" | "blocked" | "declined" | "timeout" | "running";

// The block record + kernel quarantine shapes live in ./types/tool-block.ts
// (400-LOC cap); re-exported so consumers keep importing from here.
export type { BlockLayer, KernelQuarantine, ToolBlockRecord } from "./types/tool-block.js";
export { BLOCK_LAYERS, isBlockLayer } from "./types/tool-block.js";
import type { BlockLayer } from "./types/tool-block.js";

interface ToolResultBase {
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

  /**
   * Image bytes the tool produced. The chat tool dispatcher converts this
   * into a user-role image_url message (so the model SEES the image) and the
   * WhatsApp/Telegram bridge auto-forwards it to the user as a photo. Set by
   * the vision tools (screen_capture, view_image) and generate_image.
   */
  _image?: { mime: string; b64: string; path: string; question: string };

  /**
   * Several images from ONE call — video frames, a multi-page render. Fed to
   * the model as a single user-role message carrying every frame in order, so
   * it can reason across them; `_image` stays the single-image shape and a
   * tool sets one or the other, never both.
   */
  _images?: Array<{ mime: string; b64: string; path: string; question: string }>;

  /**
   * A large media file the tool produced or wants delivered. Unlike `_image`
   * this carries a PATH, not bytes — too big to base64 onto every result and
   * the model can't ingest them as image_url. The WhatsApp/Telegram bridge
   * reads the file off disk and forwards it (image/video only — documents are
   * pulled by the client from the staged /uploads ref instead). Set by
   * generate_video and send_video (video), generate_image, edit_image and
   * send_image (image), and send_file (file, with `name` as the user-facing
   * filename). Not fed to the model; the chat's inline preview reads its name
   * off the tool_end event and the persisted carry.
   */
  _media?: { kind: "image" | "video" | "file"; path: string; mime: string; name?: string };
}

/** `status` is optional (unset, it derives from `isError`). A blocked result
 *  must name the gate that refused it (metadata.layer, one of BLOCK_LAYERS)
 *  and the next step (metadata.recovery): the compiler holds every refusal to
 *  both. */
export type ToolResult = ToolResultBase & (
  | { status?: Exclude<ToolResultStatus, "blocked"> }
  | { status: "blocked"; metadata: { recovery: string; layer: BlockLayer } & Record<string, unknown> }
);

export interface AgentTurn {
  messages: ChatCompletionMessageParam[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  stopReason: "end_turn" | "max_iterations" | "abort" | "error";
  /** When stopReason is "error", the provider's error message — used by the
   * chat route to decide whether the error is transient (rate limit, auth,
   * overload) and eligible for failover to another provider. */
  errorMessage?: string;
  /** True when at least one successful (resultStatus "ok") committing tool
   * ran during the op. Computed from the host.ts ledger in the canonical
   * runner; lets the result-guard suppress false-completion catches. */
  committedWork?: boolean;
  /** The op the turn ran as (canonical runner), for a caller that reports on
   *  the run afterwards — what it produced, where it opens. */
  opId?: string;
}

// ── Security Types ── (security-types.ts)

export * from "./security-types.js";

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
  /**
   * Automatic-compaction checkpoint: the model may be sent `summary` in place
   * of the first `coversThrough` messages. The messages themselves are still
   * here — the chat, fork, export and recall show the whole transcript; only
   * the request is shortened (memory/session-message-log.ts SessionCheckpointRow).
   */
  compactionCheckpoint?: { summary: string; coversThrough: number };
  createdAt: number;
  updatedAt: number;
  /** Session ID this session was forked from */
  forkedFrom?: string;
  /** Message index at which the fork was taken */
  forkAtIndex?: number;
  /**
   * Project this chat is nested under, if any. Durable home for the
   * chat→project link (previously client-localStorage-only, which made it
   * fragile across sync). Seeds the in-memory currentProjectBySession map
   * so agent_* spawns from this chat auto-scope to the project roster +
   * its per-project model override. Absent = not in a project.
   */
  projectId?: string;
  /**
   * Compaction lives as a leading `{role:"system", content:"[COMPACTED CONTEXT — …]"}`
   * entry in `messages` (round-tripped through a `summary` row in the
   * jsonl log). `compactedSummary` / `compactedAt` no longer exist as
   * top-level fields — code should check `messages[0]?.role === "system" &&
   * messages[0].content.startsWith(COMPACTION_PREFIX)` to detect it.
   */
}

// ── Server Types ──
// ToolChip, ActionPreview, and the ServerEvent union live in
// ./types/server-events.ts (split out to keep this file under the 400-LOC
// cap). Re-exported here so existing `from "...types.js"` imports are
// unchanged.
export type { ToolChip, ActionPreview, ServerEvent } from "./types/server-events.js";

// ── Auth Types ──

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // Captured from the OAuth response when present. Used for the optional
  // persistent or just-in-time plaintext Codex CLI mirror. Optional because
  // pre-bridge installs do not have it on disk; refresh repopulates it.
  idToken?: string;
  accountId?: string;
}

// ── Deployment Profile + Config Types ──
// DeploymentProfile, ProfileDefaults, MIN_MAX_ITERATIONS, and LAXConfig live
// in ./types/lax-config.ts (split out to keep this file under the 400-LOC
// cap, same as server-events.ts). Re-exported so existing imports are
// unchanged.
export { MIN_MAX_ITERATIONS } from "./types/lax-config.js";
export type { BrowserMode, DeploymentProfile, ProfileDefaults, LAXConfig } from "./types/lax-config.js";

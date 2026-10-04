import type { ToolDefinition, ToolResult, ToolResultStatus } from "../types.js";
import { withPrompt } from "./tool-prompt-builder.js";

/**
 * Tool-result builders.
 *
 * 95% of tools should use only `ok(s)` and `err(s)` — same as before.
 * The non-default statuses (`blocked`, `declined`, `timeout`, `running`) are
 * available as helpers but most authors never need them. The envelope
 * stays a single optional discriminator on top of the legacy shape.
 *
 * For tools that need richer signalling (bash, http_request, process_*),
 * pass a `metadata` object with conventional keys — duration_ms, exit_code,
 * recovery, stderr — and the renderer surfaces them to the model in a
 * consistent header. See `ToolResult` in src/types.ts for the full list
 * of conventional metadata keys.
 */
export function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return metadata ? { content, status: "ok", metadata } : { content };
}

export function err(content: string, metadata?: Record<string, unknown>): ToolResult {
  return metadata ? { content, isError: true, status: "error", metadata } : { content, isError: true };
}

/** What a refusal carries: `recovery` is required, the next step the agent
 *  should take instead (who can change it and where, another route, or what
 *  to tell the user), so a refusal is never a dead end. */
export type BlockedMetadata = { recovery: string } & Record<string, unknown>;

/** Refused by policy/safety — retrying won't help. The one constructor for a
 *  blocked result (blocked-results.contract.test.ts holds every site to it). */
export function blocked(content: string, metadata: BlockedMetadata): ToolResult {
  return { content, isError: true, status: "blocked", metadata };
}

/**
 * The user was asked for approval and said no to THIS call. Not a policy
 * block: the tool works, and the same tool may be approved next time. The
 * model should adjust or ask — not immediately retry the identical call
 * (though it may request approval again if the user says to proceed).
 * Produced ONLY by the user-decline branch of the approval phase.
 */
export function declined(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: true, status: "declined", metadata };
}

/** Runtime deadline expired. Partial work may have landed; metadata.partial_output captures it. */
export function timeout(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: true, status: "timeout", metadata };
}

/**
 * Async session started — model MUST poll, not wait. `hint` becomes the
 * content (e.g. "started; poll process_status with session_id=x") so a
 * model that ignores `status` still has a usable instruction.
 */
export function running(sessionId: string, hint: string, metadata?: Record<string, unknown>): ToolResult {
  return { content: hint, status: "running", session_id: sessionId, metadata };
}

/** Derive a status from any ToolResult, including legacy ones. */
export function statusOf(r: ToolResult): ToolResultStatus {
  if (r.status) return r.status;
  return r.isError ? "error" : "ok";
}

/**
 * Parse the leading status header from a rendered tool-result string —
 * the inverse of `renderToolResultForModel`. Used by the canonical
 * ChatToolDispatcher to recover the envelope status when it only has
 * the rendered message back from `executeToolCalls`. Returns "ok" when
 * no header is present (legacy verbatim path).
 *
 * Header shape (matches renderToolResultForModel):
 *   [<status>, k=v ...]\n...
 */
export function parseStatusHeader(rendered: string): ToolResultStatus {
  if (typeof rendered !== "string") return "ok";
  const m = rendered.match(/^\[(ok|error|blocked|declined|timeout|running)(?:[,\s\]])/);
  return (m?.[1] as ToolResultStatus | undefined) ?? "ok";
}

/** The `Recovery:` line renderToolResultForModel wrote, or "" when there is none. */
export function parseRecoveryLine(rendered: string): string {
  return /^Recovery: (.*)$/m.exec(rendered)?.[1] ?? "";
}

/** An envelope rebuilt from its rendered text: the status from the header and,
 *  for a refusal, the next step from its Recovery line. */
export function resultFromRendered(content: string): ToolResult {
  const status = parseStatusHeader(content);
  const isError = status !== "ok" && status !== "running";
  return status === "blocked"
    ? { content, isError, status, metadata: { recovery: parseRecoveryLine(content) } }
    : { content, isError, status };
}

/** The same result with `extra` merged into its metadata. A merge only adds
 *  keys, so a refusal keeps the recovery the type requires of it. */
export function withMetadata(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  return { ...result, metadata: { ...result.metadata, ...extra } } as ToolResult;
}

/**
 * Parse the whole leading header — status AND the scalar `k=v` metadata the
 * renderer put there — back out of a rendered result. The header is the one
 * envelope form every store keeps (op-messages, the session log, the model
 * text), so a consumer rebuilding a card from history reads the block's
 * layer / clearable / rule from here when no richer record was persisted.
 * Values render as JSON strings, numbers or booleans; a truncated string
 * ("...") comes back truncated. Returns null when no header is present.
 */
export function parseResultHeader(rendered: string): { status: ToolResultStatus; meta: Record<string, string | number | boolean> } | null {
  if (typeof rendered !== "string") return null;
  const line = rendered.split("\n", 1)[0];
  const m = /^\[(ok|error|blocked|declined|timeout|running)((?:, [^\]]*)?)\]$/.exec(line);
  if (!m) return null;
  const meta: Record<string, string | number | boolean> = {};
  for (const part of m[2].matchAll(/([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|[^,\]]+)/g)) {
    const raw = part[2];
    if (raw.startsWith("\"")) {
      try { meta[part[1]] = JSON.parse(raw) as string; } catch { meta[part[1]] = raw.slice(1, -1); }
    } else if (raw === "true" || raw === "false") meta[part[1]] = raw === "true";
    else meta[part[1]] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return { status: m[1] as ToolResultStatus, meta };
}

/**
 * Render an envelope into the string the model sees inside its tool_result
 * block. Goals:
 *   - Zero behaviour change for the ~60 legacy tools that only set
 *     `content` (+ `isError`): they get verbatim content.
 *   - For envelope-aware tools, prepend a compact `[status, k=v ...]`
 *     header so the model can pattern-match outcome state without
 *     reading prose. metadata.recovery surfaces on its own line for
 *     blocked/timeout because the model should ACT on it.
 *   - Header is one short line; total envelope overhead is ~30-80 tokens.
 *
 * Nested-envelope rule: tools that wrap subagent results (op_status, etc.)
 * MUST emit the inner result as `content` text and NOT re-wrap. The
 * dispatcher renders ONCE at the model boundary.
 */
export function renderToolResultForModel(r: ToolResult): string {
  // Legacy path: tools that don't opt into the envelope. Verbatim content.
  // isError MUST opt in: a bare {content, isError} rendered verbatim carries
  // no [error] header, and the canonical dispatcher recovers status by
  // parsing that header — so failures recorded resultStatus="ok" and every
  // status-keyed failure middleware went blind ("Failed to create document"
  // turns logged as ok, 2026-06-10).
  if (!r.status && !r.session_id && !r.metadata && !r.isError) {
    return r.content;
  }

  const status = statusOf(r);
  const meta = r.metadata || {};

  // Header: [status, exit_code=N, duration_ms=M, ...] — skip recovery,
  // userHint, partial_output (those go on their own lines below) and skip
  // nested objs.
  const headerParts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k === "recovery" || k === "partial_output" || k === "userHint") continue;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") continue;
    const rendered = typeof v === "string" && v.length > 60 ? JSON.stringify(v.slice(0, 60) + "...") : (typeof v === "string" ? JSON.stringify(v) : String(v));
    headerParts.push(`${k}=${rendered}`);
  }
  if (r.session_id) headerParts.push(`session_id=${r.session_id}`);

  const header = `[${status}${headerParts.length > 0 ? ", " + headerParts.join(", ") : ""}]`;

  const lines: string[] = [header];
  // userHint is the plain-English summary the model surfaces to the user.
  // First after the header so the "translate tool failures, never parrot"
  // prompt rule can pattern-match a single, consistent line — and so the
  // technical `reason` (in content + recovery) stays available for debug.
  if (typeof meta.userHint === "string" && meta.userHint) {
    lines.push(`User hint: ${meta.userHint}`);
  }
  if (typeof meta.recovery === "string" && meta.recovery) {
    lines.push(`Recovery: ${meta.recovery}`);
  }
  if (typeof meta.partial_output === "string" && meta.partial_output) {
    lines.push(`Partial output:\n${meta.partial_output}`);
  }
  if (r.content) lines.push(r.content);
  return lines.join("\n");
}

export const toolPrompts: Record<string, () => string> = {
  read: () => "Use read for files instead of bash cat/head/tail. Supports offset/limit for large files. When exploring code, pass include_imports:true to get the file's local imports in the same call instead of follow-up reads.",
  write: () => "Use write for new files instead of bash echo/heredoc. Read existing files before overwriting.",
  edit: () => "Use edit for targeted find-and-replace instead of bash sed/awk. Read the file first.",
  bash: () => "Only use bash for shell commands. Never use it for file read/write/search — use dedicated tools. Probe for installed tools with targeted commands (command -v / where / Get-Command); never dump the environment (printenv/env/set) — secret-shaped output is redacted and wastes the call.",
  glob: () => "Use glob for finding files by name pattern. Faster than bash find/ls.",
  grep: () => "ALWAYS use grep for content search. Never bash grep/rg. Supports regex, type filtering, 3 output modes. content mode includes surrounding context per hit by default — follow-up reads of hit files are usually unnecessary.",
  web_search: () => "Use web_search to find URLs, then web_fetch to read specific pages.",
  spreadsheet: () => "Use for Excel/CSV — never write Python pandas scripts. action:'write' takes data as a JSON array of objects (keys become headers).",
  document: () => "action:'create' content is markdown with \\n newlines. # for headings, - for bullets, **bold**.",
  presentation: () => "action:'from_outline' outlines MUST use # for slide titles and - for bullets, separated by \\n.",
  pdf: () => "action:'create' content uses # for headings, \\n\\n for paragraph breaks.",
  sql_query: () => "Read-only by default. Run sql_schema first to see available tables.",
  enter_plan_mode: () => "Enter plan mode to research before making changes. Only read tools available.",
  ask_user: () => "Calling ask_user ENDS your turn with that question as your answer — the reply comes back as the user's next message. Reserve it for a fork where guessing wastes real work or is irreversible (prod vs sandbox, which account, an unrecoverable delete). Never for confirmations you can infer, permission for work already assigned, or progress reports.",
  task_create: () => "Use for multi-step work. Tasks persist across messages.",
};

export function applyPrompts(tools: ToolDefinition[]): ToolDefinition[] {
  for (const t of tools) {
    const fn = toolPrompts[t.name];
    if (fn) withPrompt(t, fn);
  }
  return tools;
}

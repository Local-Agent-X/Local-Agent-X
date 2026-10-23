import type { BlockLayer, ToolResult, ToolResultStatus } from "../types.js";
import type { DeferredGrant } from "../inbox/types.js";

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

/** What a refusal carries: `layer`, the gate that refused it (BLOCK_LAYERS),
 *  and `recovery`, the next step the agent should take instead (who can change
 *  it and where, another route, or what to tell the user), so a refusal is
 *  never a dead end. */
export type BlockedMetadata = { recovery: string; layer: BlockLayer } & Record<string, unknown>;

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
 * The status in the leading header of a rendered tool result — the inverse of
 * `renderToolResultForModel`, for rows persisted before the tool message
 * carried `_status` (tool-execution/tool-message-carry.ts). Live code reads
 * the carry; nothing new parses the header. Returns "ok" when no header is
 * present (a legacy tool's verbatim content).
 *
 * Header shape (matches renderToolResultForModel):
 *   [<status>, k=v ...]\n...
 */
export function parseStatusHeader(rendered: string): ToolResultStatus {
  if (typeof rendered !== "string") return "ok";
  const m = rendered.match(/^\[(ok|error|blocked|declined|timeout|running)(?:[,\s\]])/);
  return (m?.[1] as ToolResultStatus | undefined) ?? "ok";
}

/**
 * What every refused call means for the model's next step: the one source for
 * the security block's recovery, the fallback below, and the turn-end failure
 * nudge, which told the model opposite things (stop / try another way) and a
 * local model quit a recoverable task on the contradiction (Terminal-Bench
 * 2.0, password-recovery, 2026-10-23).
 *
 * The line is drawn on what the refused call would have DONE, not on which
 * command ran. Getting that effect by another route is the workaround this
 * rule exists for (an agent once hand-patched build output past a false-
 * positive block, silently); pursuing the user's request by an approach that
 * never needs the refused effect is ordinary work. Telling the user what was
 * refused is unconditional, so a refusal is never hidden whichever path the
 * model takes next.
 */
export const BLOCKED_CALL_RULE =
  "Don't get what the refused call would have done by any other route — another command or spelling of it, an interpreter, a script file, an encoding, or writing its output by hand. That is a workaround, even if you think the refusal is a mistake. " +
  "You may keep working on the user's request by an approach that doesn't need what was refused. " +
  "Finish what you can, then tell the user exactly what was refused, why you needed it, and whether it looks like a mistake, so they can change the setting or approve another path.";

/** What a refusal that named no next step tells the model. */
export const BLOCKED_WITHOUT_RECOVERY =
  `This was refused and named no next step. Do not retry it unchanged. ${BLOCKED_CALL_RULE}`;

/**
 * A refusal from a gate inside a tool that would have shown a person a card
 * (a sensitive page, a credential fill, a quarantined download, a CAPTCHA) and
 * found no one watching the run: `metadata.needsUser` carries why a person is
 * needed, in their words. The dispatch pipeline parks such a call in the
 * user's inbox for an unattended run (tool-execution/deferred-call.ts
 * parkNeedsUser) and the run goes on; an attended run keeps the refusal.
 * `grant` says what the user's yes keeps beyond the one call (the item's
 * wording); it rides `metadata.needsUserGrant` and goes with the mark.
 */
export function needsUser(result: ToolResult, reason: string, grant?: DeferredGrant): ToolResult {
  return { ...result, metadata: { ...result.metadata, needsUser: reason, ...(grant ? { needsUserGrant: grant } : {}) } } as ToolResult;
}

/** The reason a result says a person is needed, what the user's yes would keep
 *  (`grant`, for the inbox item's wording), and the result without the mark. */
export function takeNeedsUser(result: ToolResult): { reason: string; result: ToolResult; grant?: DeferredGrant } | null {
  const { needsUser: reason, needsUserGrant: grant, ...metadata } = result.metadata ?? {};
  if (typeof reason !== "string" || !reason) return null;
  return { reason, result: { ...result, metadata } as ToolResult, ...(grant ? { grant: grant as DeferredGrant } : {}) };
}

/** The same result with `extra` merged into its metadata. A merge only adds
 *  keys, so a refusal keeps the recovery the type requires of it. */
export function withMetadata(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  return { ...result, metadata: { ...result.metadata, ...extra } } as ToolResult;
}

/** The rendered result without its status header line — what a person reads
 *  (the user hint, the recovery, the output), not what the model keys on. */
export function withoutResultHeader(rendered: string): string {
  return parseResultHeader(rendered) ? rendered.slice(rendered.indexOf("\n") + 1 || rendered.length) : rendered;
}

/**
 * The whole leading header — status AND the scalar `k=v` metadata the renderer
 * put there — parsed back out of a rendered result, for rows persisted before
 * the tool message carried its block record (`_block`): the session projection
 * rebuilds a legacy block's layer / clearable / rule from here. Values render
 * as JSON strings, numbers or booleans; a truncated string ("...") comes back
 * truncated. Returns null when no header is present.
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
  // Every refusal reaches the model with a next step. The type requires one
  // (types.ts), but an empty string satisfies it, and a result rebuilt from
  // rendered text that lost its line (resultFromRendered) has none; every
  // result passes through here, so the guarantee holds here.
  const recovery = typeof meta.recovery === "string" && meta.recovery
    ? meta.recovery
    : status === "blocked" ? BLOCKED_WITHOUT_RECOVERY : "";
  if (recovery) lines.push(`Recovery: ${recovery}`);
  if (typeof meta.partial_output === "string" && meta.partial_output) {
    lines.push(`Partial output:\n${meta.partial_output}`);
  }
  if (r.content) lines.push(r.content);
  return lines.join("\n");
}

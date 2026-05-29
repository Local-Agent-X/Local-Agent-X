// Within-op tool-call dedup cache. Generic backstop against the MCP-loop
// class of bugs (Anthropic CLI's agentic multi-step occasionally re-issues
// the same tool with the same args; non-idempotent tools then produce real
// side effects — duplicate emails, duplicate posts, duplicate rows).
//
// Scope is the sessionId (chat sessions) or runId (agent runs); within a
// scope, if the same tool is invoked with the same canonical args inside
// a TTL window, the cached prior result is returned and a "(deduplicated)"
// annotation is added so the model sees the no-op explicitly.
//
// The cache is a process-local Map with lazy GC on access. TTL is the
// "within one turn / op" bound — 60s is comfortably longer than the
// longest realistic single turn and tight enough that a deliberate human-
// paced retry after thinking gets through.
//
// Not used for read-class status tools where re-execution carries real
// signal (process_status, op_status, etc.) — see DEDUP_SKIP below.

import { createHash } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { ToolResult } from "../types.js";

const DEDUP_TTL_MS = 60_000;

// Tools whose re-execution carries real signal even with identical args
// (the underlying world state changes between calls). We never dedup
// these — model deserves the fresh answer. Reads (read/glob/grep) are
// dedup-safe at the 60s scale because the model already saw the answer
// once and the cached response is correct for "what does this file say
// right now."
const DEDUP_SKIP: ReadonlySet<string> = new Set([
  "process_status", "op_status", "agent_status", "session_status",
  "autopilot_status", "primal_build_status", "memory_stats",
  "task_get", "task_list", "agent_list", "agent_team_list",
  "ari_database",
  // tool_search results depend on the deferred-tool catalog which can
  // shift as a turn progresses (registered via prior tool runs).
  "tool_search",
]);

export interface DedupRecord {
  /** The tool messages that were appended to the conversation on the
   *  original execution. We replay these verbatim so the model sees the
   *  same content shape it would have on a real call. */
  msgs: ChatCompletionMessageParam[];
  allowed: boolean;
  /** Set when the original call produced a ToolResult (rendered=model
   *  path); used so the dedup terminator can carry the structured result
   *  forward into ctx.result for downstream phases (audit, hooks). */
  result?: ToolResult;
  /** Plain-text content surfaced via the tool_end event the first time;
   *  reused for the dedup-suppressed tool_end. */
  resultContent: string;
  ts: number;
}

const cache = new Map<string, DedupRecord>();

function canonicalArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    const keys = Object.keys(parsed).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = parsed[k];
    return JSON.stringify(ordered);
  } catch {
    return argsJson;
  }
}

function fingerprint(scope: string, name: string, argsJson: string): string {
  return createHash("sha256")
    .update(`${scope}|${name}|${canonicalArgs(argsJson)}`)
    .digest("hex")
    .slice(0, 24);
}

function gc(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.ts > DEDUP_TTL_MS) cache.delete(k);
  }
}

/** Returns the cached record if a matching (scope, name, args) was
 *  executed within the TTL window. Skips dedup for read-class tools where
 *  re-execution carries signal. Returns null with no side effects when
 *  no scope is available (caller can't be linked to a turn). */
export function dedupLookup(
  scope: string | undefined,
  name: string,
  argsJson: string,
): DedupRecord | null {
  if (!scope) return null;
  if (DEDUP_SKIP.has(name)) return null;
  const now = Date.now();
  gc(now);
  const key = fingerprint(scope, name, argsJson);
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.ts > DEDUP_TTL_MS) { cache.delete(key); return null; }
  return hit;
}

/** Records a successful tool execution for future dedup lookups within
 *  the TTL window. Skip-listed tools and missing-scope calls no-op. Only
 *  successful (allowed, non-error) results are recorded — failed/blocked
 *  calls SHOULD be re-attempted with the underlying issue addressed. */
export function dedupRecord(
  scope: string | undefined,
  name: string,
  argsJson: string,
  record: Omit<DedupRecord, "ts">,
): void {
  if (!scope) return;
  if (DEDUP_SKIP.has(name)) return;
  if (!record.allowed) return;
  if (record.result?.isError) return;
  const key = fingerprint(scope, name, argsJson);
  cache.set(key, { ...record, ts: Date.now() });
}

/** Test-only: drop the entire cache. */
export function _clearDedupCacheForTests(): void {
  cache.clear();
}

export const _DEDUP_TTL_MS_FOR_TESTS = DEDUP_TTL_MS;

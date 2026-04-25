/**
 * Retry telemetry sidecar — collect retry/failover patterns silently.
 *
 * Zero behavior change. Pure append-only JSONL at
 * ~/.sax/telemetry/retries.jsonl so we can later analyze:
 *   - which providers return 0-token responses and when
 *   - which tools fail most often with what errors
 *   - which fallback paths fire and how often
 *   - which sessions get stuck in retry spirals
 *
 * Read it with: jq -s 'group_by(.kind) | map({kind: .[0].kind, n: length})' ~/.sax/telemetry/retries.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".lax", "telemetry");
const FILE = join(DIR, "retries.jsonl");

export type RetryKind =
  | "empty-response-fallback"    // primary provider returned 0 tokens → falling back
  | "tool-arg-invalid"           // tool call rejected for bad args (self-correction)
  | "tool-blocked"               // policy/RBAC denied a tool
  | "context-overflow"           // auto-compaction fired
  | "provider-auth-rotate"       // auth token rotated
  | "model-fallback"             // model failover (e.g. codex → anthropic)
  | "loop-abort"                 // loop detector aborted repeating tool calls
  | "mcp-handled-tool"           // mcp__ tool routed via bridge
  | "custom";                    // free-form

interface RetryEvent {
  ts: string;                    // ISO
  kind: RetryKind;
  sessionId?: string;
  provider?: string;
  model?: string;
  tool?: string;
  detail?: Record<string, unknown>;
}

let _inited = false;
function ensure(): void {
  if (_inited) return;
  try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 }); _inited = true; } catch {}
}

/** Log a retry/failover event. Silent — never throws. */
export function logRetry(event: Omit<RetryEvent, "ts">): void {
  try {
    ensure();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(FILE, line);
  } catch { /* telemetry must not break agent flow */ }
}

/**
 * Tool usage telemetry sidecar — count every dispatched tool call silently.
 *
 * Zero behavior change. Pure append-only JSONL at
 * ~/.lax/telemetry/tool-usage.jsonl so the eager/deferred tool tiering in
 * src/tools/audience-map.ts can be driven by observed usage instead of
 * guesswork:
 *   - which tools actually get called, how often, from which audience
 *   - which action a collapsed family tool (protocol, spreadsheet, …) ran
 *   - how often calls end ok vs error vs blocked
 *
 * Read it with: jq -s 'group_by(.tool) | map({tool: .[0].tool, n: length}) | sort_by(-.n)' ~/.lax/telemetry/tool-usage.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

const DIR = join(getLaxDir(), "telemetry");
const FILE = join(DIR, "tool-usage.jsonl");

interface ToolUsageEvent {
  ts: string;                    // ISO
  tool: string;
  /** args.action for one-tool-many-actions families (browser, protocol, office). */
  action?: string;
  status: "ok" | "error" | "blocked" | string;
  durationMs?: number;
  sessionId?: string;
  callContext?: string;
}

let _inited = false;
function ensure(): void {
  if (_inited) return;
  try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 }); _inited = true; } catch {}
}

/** Log one tool invocation. Silent — never throws. */
export function logToolUsage(event: Omit<ToolUsageEvent, "ts">): void {
  try {
    ensure();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(FILE, line);
  } catch { /* telemetry must not break agent flow */ }
}

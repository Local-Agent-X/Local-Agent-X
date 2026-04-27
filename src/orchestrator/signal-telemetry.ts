/**
 * Orchestrator signal telemetry — produced vs injected vs dropped.
 *
 * mergeSignals() in signals.ts ranks ModuleSignals and slices to
 * MAX_CONTEXT_SIGNALS. Without telemetry we can't tell which conversational
 * modules ever inject anything into the agent prompt vs being dropped every
 * turn. Append-only JSONL at ~/.lax/telemetry/signals.jsonl so we can answer
 * that empirically and decide what to keep, demote, or delete.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ModuleSignal } from "./types.js";

const DIR = join(homedir(), ".lax", "telemetry");
const FILE = join(DIR, "signals.jsonl");

export interface SignalRef {
  module: string;
  category: string;
  priority: number;
  preview: string;
}

export interface SignalTrace {
  ts: string;
  sessionId?: string;
  produced: SignalRef[];
  injected: SignalRef[];
  dropped: SignalRef[];
}

let _inited = false;
function ensure(): void {
  if (_inited) return;
  try { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 }); _inited = true; } catch {}
}

export function toSignalRef(s: ModuleSignal): SignalRef {
  return {
    module: s.source,
    category: s.category,
    priority: s.priority,
    preview: s.signal.slice(0, 80),
  };
}

export function logSignalTrace(trace: Omit<SignalTrace, "ts">): void {
  try {
    ensure();
    const row: SignalTrace = { ts: new Date().toISOString(), ...trace };
    appendFileSync(FILE, JSON.stringify(row) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {}
}

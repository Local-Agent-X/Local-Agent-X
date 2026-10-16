import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.js";

// Each tool's timeout is its policy row's `timeoutMs`. It is a hang-catcher for
// tools that should finish quickly, not a work-limiter: 0 (or negative) means
// "unbounded", for tools that legitimately run for minutes (sub-agents, a CLI
// subprocess, the worker pool, a card the user has to answer).

// Generous fallback for a tool whose row sets none: the timeout exists to catch
// a hang, not to cap legitimate work, so an un-tuned tool gets two minutes
// before we abandon it rather than the old 30s (which killed slow tools).
export const DEFAULT_FALLBACK = 120_000;

/** Thrown by withTimeout when the deadline fires. run-sandboxed maps this to a
 *  `status:"timeout"` ToolResult so the model always gets a result row. */
export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly ms: number;
  constructor(toolName: string, ms: number) {
    super(`Tool "${toolName}" timed out after ${ms}ms`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
    this.ms = ms;
  }
}

function configPath(): string {
  return join(getLaxDir(), "tool-timeouts.json");
}

function loadCustomTimeouts(): Record<string, number> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function saveCustomTimeouts(timeouts: Record<string, number>): void {
  const dir = getLaxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(timeouts, null, 2), "utf-8");
}

/** Per-tool timeout in ms. A return of <= 0 means "unbounded" — callers MUST
 *  skip wrapping (do not pass 0 to withTimeout). */
export function getToolTimeout(toolName: string): number {
  const custom = loadCustomTimeouts();
  if (custom[toolName] !== undefined) return custom[toolName];
  return TOOL_POLICIES[toolName]?.timeoutMs ?? DEFAULT_FALLBACK;
}

export function setToolTimeout(toolName: string, ms: number): void {
  const custom = loadCustomTimeouts();
  custom[toolName] = ms;
  saveCustomTimeouts(custom);
}

/**
 * `ms` bounds the TOOL's own work. `excludedMs` reports time the call spent
 * waiting on something that is not the tool working — a human deciding an
 * approval (approval-manager.ts approvalWaitMsFor), or a shell waiting for the
 * Windows cage's startup proof (sandbox awaitSandboxProof). Without it the two
 * budgets fought: a 30s browser timeout around a 5-minute approval card meant
 * every sensitive-page action timed out before the user could answer, and the
 * retry raised another card (live 2026-09-16, Google Cloud console).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
  excludedMs?: () => number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const startedAt = Date.now();

  const timeout = new Promise<never>((_, reject) => {
    const arm = (delay: number): void => {
      timer = setTimeout(() => {
        // Re-check at the deadline rather than polling: whatever was excluded
        // while we waited buys exactly that much more wall clock, once.
        const remaining = startedAt + ms + (excludedMs?.() ?? 0) - Date.now();
        if (remaining > 0) { arm(remaining); return; }
        reject(new ToolTimeoutError(toolName, ms));
      }, Math.max(1, delay));
    };
    arm(ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

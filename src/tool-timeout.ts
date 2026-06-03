import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

// A timeout of 0 (or negative) means "unbounded — never time out". Used to
// EXEMPT tools that legitimately run for minutes: they spawn sub-agents,
// drive a CLI subprocess (claude/codex), or block on a worker pool. The
// timeout here is a hang-catcher for tools that should finish quickly, not a
// work-limiter — killing a real long-runner would be the bigger bug.
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  bash: 120_000,
  browser: 30_000,
  web_search: 15_000,
  http_request: 60_000,
  web_fetch: 60_000,
  read: 10_000,
  write: 10_000,
  edit: 10_000,
  view_image: 10_000,

  // ── Exempt long-runners (0 = unbounded) ──
  // self_edit drives a claude/codex subprocess; build_app / start_app_build /
  // primal_run_build_plan kick off canonical app-build ops; op_submit blocks
  // on the worker pool up to 30min; operation_start / agent_* / delegate /
  // swarm_create spawn sub-agents. None of these are hung when they run long.
  self_edit: 0,
  build_app: 0,
  start_app_build: 0,
  finalize_app_build: 0,
  primal_run_build_plan: 0,
  op_submit: 0,
  op_submit_async: 0,
  operation_start: 0,
  agent_spawn: 0,
  agent_create: 0,
  delegate: 0,
  swarm_create: 0,
};

// Generous fallback for UNLISTED tools: the timeout exists to catch a hang,
// not to cap legitimate work, so an un-tuned tool gets two minutes before we
// abandon it rather than the old 30s (which prematurely killed slow tools).
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
  if (DEFAULT_TIMEOUTS[toolName] !== undefined) return DEFAULT_TIMEOUTS[toolName];
  return DEFAULT_FALLBACK;
}

export function setToolTimeout(toolName: string, ms: number): void {
  const custom = loadCustomTimeouts();
  custom[toolName] = ms;
  saveCustomTimeouts(custom);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError(toolName, ms));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

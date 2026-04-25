import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_TIMEOUTS: Record<string, number> = {
  bash: 120_000,
  browser: 30_000,
  web_search: 15_000,
  read: 10_000,
  write: 10_000,
  edit: 10_000,
  view_image: 10_000,
};

const DEFAULT_FALLBACK = 30_000;

function configPath(): string {
  return join(homedir(), ".lax", "tool-timeouts.json");
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
  const dir = join(homedir(), ".lax");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(timeouts, null, 2), "utf-8");
}

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
      reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

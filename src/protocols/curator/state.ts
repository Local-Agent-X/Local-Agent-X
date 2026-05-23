import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../../config.js";
import { getAllProtocols } from "../../protocols.js";
import type { CuratorState } from "./types.js";

export function curatorDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "protocols", ".curator");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const reports = join(dir, "reports");
  if (!existsSync(reports)) mkdirSync(reports, { recursive: true });
  return dir;
}

function statePath(): string {
  return join(curatorDir(), "state.json");
}

export function loadCuratorState(): CuratorState {
  const p = statePath();
  if (!existsSync(p)) return { lastRunTs: 0, lastReportPath: "", runs: 0 };
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return { lastRunTs: 0, lastReportPath: "", runs: 0 }; }
}

export function saveCuratorState(s: CuratorState): void {
  writeFileSync(statePath(), JSON.stringify(s, null, 2), "utf-8");
}

/** Throttle for the scheduled background pass: skip if a run completed within
 *  the last `minIntervalHours` AND the catalog hasn't grown since. */
export function shouldCurate(opts: { minIntervalHours?: number; minCustomProtocols?: number } = {}): boolean {
  const minInterval = (opts.minIntervalHours ?? 18) * 3_600_000;
  const minCustom = opts.minCustomProtocols ?? 5;
  const customCount = getAllProtocols().filter((p) => p.source?.type === "custom").length;
  if (customCount < minCustom) return false;
  const state = loadCuratorState();
  if (Date.now() - state.lastRunTs < minInterval) return false;
  return true;
}

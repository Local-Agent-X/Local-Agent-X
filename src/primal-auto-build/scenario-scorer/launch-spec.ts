/**
 * Read a project's `.primal-launch.json` — declares how to start the
 * dev server so the scenario-scorer can drive it.
 *
 * Format:
 *   {
 *     "start": "pnpm dev",
 *     "ready_url": "http://localhost:5173",
 *     "ready_timeout_ms": 60000,
 *     "test_credentials_env": "PRIMAL_TEST_CREDS"
 *   }
 *
 * Lives at `<project_dir>/.primal-launch.json`. Optional — when absent,
 * the scenario-scorer skips and the loop halts at the phase gate
 * normally (manual scoring). /app-build emits this file as part of the
 * spec phase.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectLaunchSpec } from "./types.js";

export const LAUNCH_SPEC_FILENAME = ".primal-launch.json";

export function readLaunchSpec(projectDir: string): ProjectLaunchSpec | null {
  const p = join(projectDir, LAUNCH_SPEC_FILENAME);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    const start = String(raw.start || "").trim();
    const readyUrl = String(raw.ready_url || "").trim();
    if (!start || !readyUrl) return null;
    const readyTimeoutMs = Number.isFinite(Number(raw.ready_timeout_ms))
      ? Math.max(5_000, Math.floor(Number(raw.ready_timeout_ms)))
      : 60_000;
    const testCredentialsEnv = typeof raw.test_credentials_env === "string" && raw.test_credentials_env.trim()
      ? raw.test_credentials_env.trim()
      : undefined;
    return { start, readyUrl, readyTimeoutMs, testCredentialsEnv };
  } catch {
    return null;
  }
}

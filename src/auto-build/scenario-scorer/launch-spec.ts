/**
 * Read a project's `.lax-launch.json` — declares how to start the
 * dev server so the scenario-scorer can drive it.
 *
 * Format:
 *   {
 *     "start": "pnpm dev",
 *     "ready_url": "http://localhost:5173",
 *     "ready_timeout_ms": 60000,
 *     "test_credentials_env": "LAX_TEST_CREDS",
 *     "env": { "EXPO_PUBLIC_TWIN": "1" }
 *   }
 *
 * `env` is the app's test mode: plain settings the judge starts it with (stand-ins
 * for outside services, a bot check off). The file is committed, so no secrets.
 *
 * Lives at `<project_dir>/.lax-launch.json`. A file the judge cannot use says
 * why (`invalid`): label-check's named the command `command` and the port
 * `port`, was read as no file at all, and no chunk of a 13-chunk build was ever
 * scored against its sealed suite (2026-11-23). /greenfield writes this file in
 * its foundation phase.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectLaunchSpec } from "./types.js";

export const LAUNCH_SPEC_FILENAME = ".lax-launch.json";
/** Pre-rename filename — read when the new one is absent. */
const LEGACY_LAUNCH_SPEC_FILENAME = ".primal-launch.json";

export type LaunchSpecRead =
  | { kind: "ok"; spec: ProjectLaunchSpec }
  | { kind: "absent" }
  | { kind: "invalid"; reason: string };

/** The shape the judge reads, for a builder told to write or fix the file. */
export const LAUNCH_SPEC_SHAPE = `{"start": "<command that starts the app>", "ready_url": "<URL that answers once it is up>"}`;

export function readLaunchSpec(projectDir: string): LaunchSpecRead {
  let p = join(projectDir, LAUNCH_SPEC_FILENAME);
  if (!existsSync(p)) p = join(projectDir, LEGACY_LAUNCH_SPEC_FILENAME);
  if (!existsSync(p)) return { kind: "absent" };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", reason: `${LAUNCH_SPEC_FILENAME} is not a JSON object. The judge reads ${LAUNCH_SPEC_SHAPE}.` };
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    return { kind: "invalid", reason: `${LAUNCH_SPEC_FILENAME} is not valid JSON (${(e as Error).message}). The judge reads ${LAUNCH_SPEC_SHAPE}.` };
  }
  const start = typeof raw.start === "string" ? raw.start.trim() : "";
  const readyUrl = typeof raw.ready_url === "string" ? raw.ready_url.trim() : "";
  if (!start || !readyUrl) {
    const missing = [!start && "start", !readyUrl && "ready_url"].filter(Boolean).join(" and ");
    const found = Object.keys(raw).join(", ") || "nothing";
    return {
      kind: "invalid",
      reason: `${LAUNCH_SPEC_FILENAME} has no ${missing} (it has: ${found}), so the judge cannot start the app. The judge reads ${LAUNCH_SPEC_SHAPE}.`,
    };
  }
  const readyTimeoutMs = Number.isFinite(Number(raw.ready_timeout_ms))
    ? Math.max(5_000, Math.floor(Number(raw.ready_timeout_ms)))
    : 60_000;
  const testCredentialsEnv = typeof raw.test_credentials_env === "string" && raw.test_credentials_env.trim()
    ? raw.test_credentials_env.trim()
    : undefined;
  const env = raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)
    ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
    : undefined;
  return { kind: "ok", spec: { start, readyUrl, readyTimeoutMs, testCredentialsEnv, ...(env && Object.keys(env).length ? { env } : {}) } };
}


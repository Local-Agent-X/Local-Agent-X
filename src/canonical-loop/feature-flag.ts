/**
 * Feature-flag reader for `lax.canonical_loop.{lane}` (PRD §17).
 *
 * Default is ON — canonical-loop is the standard execution path for every
 * lane. The legacy fork-pool path remains in tree as a rollback target only.
 *
 * Env vars (case-insensitive):
 *   LAX_CANONICAL_LOOP_INTERACTIVE
 *   LAX_CANONICAL_LOOP_BUILD
 *   LAX_CANONICAL_LOOP_IDE
 *   LAX_CANONICAL_LOOP_BACKGROUND
 *   LAX_CANONICAL_LOOP_ALL          (catch-all override; wins over per-lane)
 *
 * Recognized values:
 *   truthy: "1", "true", "yes", "on"     → canonical
 *   falsy:  "0", "false", "no", "off"    → legacy
 *   unset/blank/unparseable              → default ON (canonical)
 *
 * `LAX_CANONICAL_LOOP_ALL`, when explicitly set, overrides every per-lane
 * value (either direction). The flag is captured per-op at submission time
 * (PRD §17) so changing it never affects in-flight ops.
 */
import type { CanonicalLane } from "./types.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function readTriBoolEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return undefined;
}

const LANE_ENV: Record<CanonicalLane, string> = {
  interactive: "LAX_CANONICAL_LOOP_INTERACTIVE",
  build: "LAX_CANONICAL_LOOP_BUILD",
  ide: "LAX_CANONICAL_LOOP_IDE",
  background: "LAX_CANONICAL_LOOP_BACKGROUND",
};

export function isCanonicalLoopEnabled(lane: CanonicalLane): boolean {
  const all = readTriBoolEnv("LAX_CANONICAL_LOOP_ALL");
  if (all !== undefined) return all;
  const envName = LANE_ENV[lane];
  if (!envName) return true;
  const perLane = readTriBoolEnv(envName);
  if (perLane !== undefined) return perLane;
  return true;
}

/** Test helper — read the env var name for a lane. Not for production logic. */
export function envVarForLane(lane: CanonicalLane): string | undefined {
  return LANE_ENV[lane];
}

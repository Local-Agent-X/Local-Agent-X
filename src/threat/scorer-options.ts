/**
 * THREAT SCORER OPTIONS - settings.json overrides for the risk scorer.
 *
 * Reads ~/.lax/settings.json:
 *   { "threat": { "startingBudget": 60, "decayPerHour": 5, "decayPerTurn": 1 } }
 * Defaults live in ThreatScorer; this just lets settings.json override them.
 * Owns the 1s read cache so session creation doesn't hit disk every time.
 */

import { loadSettings, reloadSettings } from "../settings.js";

import { type ThreatScorerOptions } from "./scoring.js";

// ── Tunable threat-calibration settings ──
// Cached 1s to avoid disk I/O on every session creation.
let _cachedScorerOpts: ThreatScorerOptions | null = null;
let _scorerOptsCachedAt = 0;

export function readThreatScorerOptions(): ThreatScorerOptions {
  if (_cachedScorerOpts && Date.now() - _scorerOptsCachedAt < 1000) return _cachedScorerOpts;
  const opts: ThreatScorerOptions = {};
  const raw = loadSettings() as { threat?: Record<string, unknown> };
  const t = raw.threat;
  if (t && typeof t === "object") {
    if (typeof t.startingBudget === "number" && t.startingBudget >= 0) opts.startingBudget = t.startingBudget;
    if (typeof t.decayPerHour === "number" && t.decayPerHour >= 0) opts.decayPerHour = t.decayPerHour;
    if (typeof t.decayPerTurn === "number" && t.decayPerTurn >= 0) opts.decayPerTurn = t.decayPerTurn;
  }
  _cachedScorerOpts = opts;
  _scorerOptsCachedAt = Date.now();
  return opts;
}

/** Test-only — invalidate the cached settings so the next session re-reads
 *  ~/.lax/settings.json. Exported so settings-override tests can change
 *  the file at runtime and observe the effect on a fresh scorer. */
export function _invalidateThreatSettingsCacheForTests(): void {
  _cachedScorerOpts = null;
  _scorerOptsCachedAt = 0;
  // loadSettings() holds its own permanent module cache; clear it too so the
  // next session genuinely re-reads ~/.lax/settings.json (the contract above).
  reloadSettings();
}

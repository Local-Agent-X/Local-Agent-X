import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { FactKind, MemoryConfig, MemorySearchResult } from "../types.js";
import {
  applyTemporalDecay, applyTemporalQueryBoost, mmrRerank,
} from "../search-helpers.js";
import { parseDateRange, dateInRange } from "../date-parser.js";
import { slugify } from "../utils.js";

export function postProcess(
  db: InstanceType<typeof Database>,
  config: MemoryConfig,
  results: MemorySearchResult[],
  maxResults: number,
  minScore: number,
  options?: { since?: Date; entities?: string[]; kind?: FactKind; project?: string; sourceType?: string; dateFrom?: string; dateTo?: string; query?: string; sessionId?: string; crossSession?: boolean }
): MemorySearchResult[] {
  // Cross-session gate. Default-deny: if a sessionId is provided and the
  // caller hasn't explicitly opted into cross-session, drop chunks tagged
  // with a different session_id. Profile-level chunks (no session_id) are
  // always allowed through — they're the stable per-user knowledge.
  if (options?.sessionId && !options?.crossSession) {
    const sid = options.sessionId;
    results = results.filter((r) => {
      const chunkSid = r.metadata?.session_id;
      return !chunkSid || chunkSid === sid;
    });
  }

  // applySessionGrouping intentionally boosts results that share a session
  // with other top hits — it's a cross-session move. Only run it when the
  // caller is explicitly searching across sessions.
  if (options?.crossSession) {
    results = applySessionGrouping(results);
  }

  if (options?.query) {
    const range = parseDateRange(options.query);
    if (range) {
      if (range.confidence === "hard") {
        const filtered = results.filter(r => {
          const d = r.metadata?.date;
          if (!d) return true;
          return dateInRange(d, range);
        });
        if (filtered.some(r => r.metadata?.date && dateInRange(r.metadata.date, range))) {
          results = filtered;
        }
      } else {
        for (const r of results) {
          if (r.metadata?.date && dateInRange(r.metadata.date, range)) {
            r.score = Math.min(1, r.score + 0.20);
          }
        }
        results.sort((a, b) => b.score - a.score);
      }
    }
    results = applyTemporalQueryBoost(results, options.query);
  }

  if (config.temporalDecayEnabled) {
    results = applyTemporalDecay(results, config.temporalHalfLifeDays);
  }

  if (config.mmrEnabled) {
    results = mmrRerank(results, maxResults, config.mmrLambda);
  }

  if (options?.since) {
    const sinceMs = options.since.getTime();
    results = results.filter((r) => {
      const dateMatch = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) return true;
      return new Date(dateMatch[1]).getTime() >= sinceMs;
    });
  }

  if (options?.entities && options.entities.length > 0) {
    const slugs = new Set(options.entities.map((e) => slugify(e)));
    results = results.filter((r) => {
      if (!r.entities || r.entities.length === 0) return true;
      return r.entities.some((e) => slugs.has(slugify(e)));
    });
  }

  if (options?.project || options?.sourceType || options?.dateFrom || options?.dateTo) {
    results = results.filter((r) => {
      const meta = r.metadata;
      if (!meta) return false;
      if (options.project && meta.project !== options.project) return false;
      if (options.sourceType && meta.source_type !== options.sourceType) return false;
      if (options.dateFrom && (!meta.date || meta.date < options.dateFrom)) return false;
      if (options.dateTo && (!meta.date || meta.date > options.dateTo)) return false;
      return true;
    });
  }

  return results.filter((r) => r.score >= minScore).slice(0, maxResults);
}

export function applyGraphBoost(
  traverseFromFn: (entity: string, maxHops: number) => Set<string>,
  results: MemorySearchResult[],
  query: string
): MemorySearchResult[] {
  if (results.length === 0) return results;

  const candidates = new Set<string>();
  const words = query.split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9-]/g, "");
    if (clean.length >= 2 && /^[A-Z]/.test(w)) {
      candidates.add(slugify(clean));
    }
  }
  if (candidates.size < 2) return results;

  const connectedEntities = new Set<string>();
  for (const entity of candidates) {
    const reachable = traverseFromFn(entity, 1);
    for (const r of reachable) connectedEntities.add(r);
  }
  if (connectedEntities.size === 0) return results;

  if (connectedEntities.size >= 15) return results;

  const GRAPH_BOOST = 0.08;
  for (const r of results) {
    if (!r.entities || r.entities.length === 0) continue;
    const hit = r.entities.some((e) => connectedEntities.has(slugify(e)));
    if (hit) {
      r.score = Math.min(1, r.score + GRAPH_BOOST);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function applySessionGrouping(results: MemorySearchResult[]): MemorySearchResult[] {
  if (results.length === 0) return results;
  const sessionScores = new Map<string, number>();
  for (const r of results) {
    const sid = r.metadata?.session_id;
    if (!sid) continue;
    const existing = sessionScores.get(sid) || 0;
    if (r.score > existing) sessionScores.set(sid, r.score);
  }
  if (sessionScores.size === 0) return results;

  const GROUPING_BOOST = 0.2;
  for (const r of results) {
    const sid = r.metadata?.session_id;
    if (!sid) continue;
    const topScore = sessionScores.get(sid) || 0;
    if (r.score < topScore) {
      r.score = Math.min(1, r.score + topScore * GROUPING_BOOST);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

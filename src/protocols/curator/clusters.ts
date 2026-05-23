// Cluster detection via embeddings cache.
//
// Hits the same embeddings.json file dedup.ts writes. We don't re-embed here:
// if the cache doesn't have an entry for a protocol, we skip it. The dedup
// pass on protocol_create populates the cache incrementally; the curator is
// the consumer.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntimeConfig } from "../../config.js";
import type { Cluster, EmbeddingCache } from "./types.js";

export function loadEmbeddingCache(): EmbeddingCache {
  const cfg = getRuntimeConfig();
  const p = join(resolve(cfg.workspace, "protocols"), "embeddings.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Union-find cluster of protocol names whose pairwise cosine ≥ threshold.
 *  Threshold is intentionally below the write-time dedup threshold (0.85) —
 *  we're looking for "could be consolidated", not "exact duplicates". */
export function findClusters(names: string[], cache: EmbeddingCache, threshold = 0.78): Cluster[] {
  const present = names.filter((n) => Array.isArray(cache[n]?.vec));
  const parent = new Map<string, string>();
  const maxSim = new Map<string, number>();
  for (const n of present) { parent.set(n, n); maxSim.set(n, 0); }

  const find = (x: string): string => {
    let p = parent.get(x)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(x, p);
    return p;
  };

  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i], b = present[j];
      const sim = cosine(cache[a].vec, cache[b].vec);
      if (sim >= threshold) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
        if (sim > (maxSim.get(a) || 0)) maxSim.set(a, sim);
        if (sim > (maxSim.get(b) || 0)) maxSim.set(b, sim);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const n of present) {
    const r = find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(n);
  }
  const clusters: Cluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const cohesion = Math.max(...members.map((m) => maxSim.get(m) || 0));
    clusters.push({ members: members.sort(), cohesion });
  }
  return clusters.sort((a, b) => b.cohesion - a.cohesion);
}

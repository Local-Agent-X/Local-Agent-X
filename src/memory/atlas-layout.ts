// Computes the memory atlas layout: every embedded chunk gets a 3D position
// (PCA over a JL-projected space, so similar memories sit together) and a
// cluster id (k-means), plus per-cluster labels and colors. Heavy, so it runs
// once per signature and is cached both in memory and on disk — a restart reads
// the disk cache instead of recomputing. The compute yields to the event loop
// throughout, so it never freezes the server.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createLogger } from "../logger.js";
import { makeJL, project, topEigenvectors, palette, tokenize, labelClusters } from "./atlas-math.js";
import { kmeans } from "./atlas-cluster.js";

const logger = createLogger("memory.atlas-layout");

const DOUT = 48; // JL working dimension
const LIMIT = 40000;
// Bump when the layout/label algorithm changes so stale disk caches recompute.
const VERSION = "v3";
const yieldTick = () => new Promise<void>((r) => setImmediate(r));

export interface AtlasCluster {
  id: number;
  label: string;
  color: [number, number, number];
  count: number;
  cx: number;
  cy: number;
  cz: number;
}

export interface AtlasLayout {
  signature: string;
  ids: number[];
  xyz: number[]; // length n*3, normalized to roughly [-1.3, 1.3]
  cluster: number[];
  clusters: AtlasCluster[];
}

let cache: AtlasLayout | null = null;
let inflight: Promise<AtlasLayout | null> | null = null;

export async function getLayout(dataDir: string, signature: string): Promise<AtlasLayout | null> {
  const sig = `${VERSION}:${signature}`;
  if (cache && cache.signature === sig) return cache;
  if (inflight) return inflight;
  inflight = compute(dataDir, sig)
    .then((r) => { cache = r; return r; })
    .catch((e) => { logger.warn(`[atlas] layout compute failed: ${(e as Error).message}`); return null; })
    .finally(() => { inflight = null; });
  return inflight;
}

function cachePath(dataDir: string): string {
  return join(dataDir, "memory-atlas.cache.json");
}

function readDiskCache(dataDir: string, signature: string): AtlasLayout | null {
  try {
    const p = cachePath(dataDir);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as AtlasLayout;
    return parsed.signature === signature ? parsed : null;
  } catch {
    return null;
  }
}

async function compute(dataDir: string, signature: string): Promise<AtlasLayout | null> {
  const disk = readDiskCache(dataDir, signature);
  if (disk) return disk;

  const db = new Database(join(dataDir, "memory.db"), { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      "SELECT id, embedding, substr(text, 1, 120) AS snip FROM chunks WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?",
    );

    const ids: number[] = [];
    const snips: string[] = [];
    let dIn = 0;
    let jl: Float32Array | null = null;
    let proj: Float32Array | null = null;
    const tmp = new Float32Array(DOUT);
    let n = 0;

    for (const r of rows.iterate(LIMIT) as Iterable<{ id: number; embedding: string; snip: string }>) {
      let vec: number[];
      try { vec = JSON.parse(r.embedding); } catch { continue; }
      if (!Array.isArray(vec) || vec.length === 0) continue;
      if (!jl) {
        dIn = vec.length;
        jl = makeJL(dIn, DOUT, 1337);
        proj = new Float32Array(LIMIT * DOUT);
      }
      if (vec.length !== dIn) continue; // mixed-dim embeddings (provider switch) — skip stragglers
      project(vec, jl, dIn, DOUT, tmp);
      proj!.set(tmp, n * DOUT);
      ids.push(r.id);
      snips.push(r.snip || "");
      n++;
      if ((n & 511) === 0) await yieldTick();
    }

    if (n === 0 || !proj) return null;
    proj = proj.subarray(0, n * DOUT) as Float32Array;

    const xyz = await projectTo3D(proj, n);
    const k = Math.max(8, Math.min(28, Math.round(n / 1500)));
    const { assign } = await kmeans(proj, n, DOUT, k);
    const clusters = buildClusters(k, assign, snips, xyz, n);

    const layout: AtlasLayout = {
      signature,
      ids,
      xyz: Array.from(xyz),
      cluster: Array.from(assign),
      clusters,
    };
    try { writeFileSync(cachePath(dataDir), JSON.stringify(layout)); } catch (e) {
      logger.warn(`[atlas] disk cache write failed: ${(e as Error).message}`);
    }
    return layout;
  } finally {
    db.close();
  }
}

async function projectTo3D(proj: Float32Array, n: number): Promise<Float32Array> {
  const mean = new Float64Array(DOUT);
  for (let i = 0; i < n; i++) {
    const base = i * DOUT;
    for (let j = 0; j < DOUT; j++) mean[j] += proj[base + j];
  }
  for (let j = 0; j < DOUT; j++) mean[j] /= n;

  const cov = new Float64Array(DOUT * DOUT);
  const c = new Float64Array(DOUT);
  for (let i = 0; i < n; i++) {
    const base = i * DOUT;
    for (let j = 0; j < DOUT; j++) c[j] = proj[base + j] - mean[j];
    for (let a = 0; a < DOUT; a++) {
      const row = a * DOUT;
      const ca = c[a];
      for (let b = a; b < DOUT; b++) cov[row + b] += ca * c[b];
    }
    if ((i & 1023) === 0) await yieldTick();
  }
  for (let a = 0; a < DOUT; a++) {
    for (let b = a; b < DOUT; b++) {
      const v = cov[a * DOUT + b] / n;
      cov[a * DOUT + b] = v;
      cov[b * DOUT + a] = v;
    }
  }

  const ev = topEigenvectors(cov, DOUT, 7);
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const base = i * DOUT;
    for (let axis = 0; axis < 3; axis++) {
      let s = 0;
      const e = ev[axis];
      for (let j = 0; j < DOUT; j++) s += (proj[base + j] - mean[j]) * e[j];
      xyz[i * 3 + axis] = s;
    }
    if ((i & 2047) === 0) await yieldTick();
  }
  // Normalize by the 95th-percentile radius, not the max — a few outliers would
  // otherwise squash the bulk of the cloud into a tiny central ball. Outliers
  // clip to the edge instead, so clusters spread out and stay readable.
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    radii[i] = Math.sqrt(x * x + y * y + z * z);
  }
  radii.sort();
  const p95 = radii[Math.floor(n * 0.95)] || 1e-6;
  const scale = 1.2 / p95;
  for (let i = 0; i < xyz.length; i++) {
    xyz[i] = Math.max(-1.8, Math.min(1.8, xyz[i] * scale));
  }
  return xyz;
}

function buildClusters(
  k: number,
  assign: Int32Array,
  snips: string[],
  xyz: Float32Array,
  n: number,
): AtlasCluster[] {
  const colors = palette(k);
  const buckets: Array<Map<string, number>> = Array.from({ length: k }, () => new Map());
  const sum = new Float64Array(k * 3);
  const cnt = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    const counts = buckets[c];
    for (const term of tokenize(snips[i])) counts.set(term, (counts.get(term) || 0) + 1);
    cnt[c]++;
    sum[c * 3] += xyz[i * 3];
    sum[c * 3 + 1] += xyz[i * 3 + 1];
    sum[c * 3 + 2] += xyz[i * 3 + 2];
  }
  const labels = labelClusters(buckets, 2);
  const out: AtlasCluster[] = [];
  for (let c = 0; c < k; c++) {
    if (cnt[c] === 0) continue;
    out.push({
      id: c,
      label: labels[c],
      color: colors[c],
      count: cnt[c],
      cx: sum[c * 3] / cnt[c],
      cy: sum[c * 3 + 1] / cnt[c],
      cz: sum[c * 3 + 2] / cnt[c],
    });
  }
  return out;
}

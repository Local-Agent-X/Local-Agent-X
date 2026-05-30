// k-means over the JL-projected memory vectors. Async with periodic yields so a
// 30k-point clustering pass never blocks the event loop for seconds at a time —
// the server stays responsive while a layout computes. Seeded init for stable
// cluster assignments across recomputes.

import { makeRng } from "./atlas-math.js";

const yieldTick = () => new Promise<void>((r) => setImmediate(r));

function dist2(data: Float32Array, i: number, centroids: Float32Array, c: number, d: number): number {
  let s = 0;
  const a = i * d, b = c * d;
  for (let k = 0; k < d; k++) {
    const diff = data[a + k] - centroids[b + k];
    s += diff * diff;
  }
  return s;
}

export async function kmeans(
  data: Float32Array,
  n: number,
  d: number,
  k: number,
): Promise<{ assign: Int32Array; centroids: Float32Array }> {
  const rng = makeRng(0x9e3779b9 ^ n);
  const centroids = new Float32Array(k * d);

  // k-means++ seeding.
  let first = Math.floor(rng() * n);
  centroids.set(data.subarray(first * d, first * d + d), 0);
  const best = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dd = dist2(data, i, centroids, c - 1, d);
      if (dd < best[i]) best[i] = dd;
      sum += best[i];
      if ((i & 4095) === 0) await yieldTick();
    }
    let target = rng() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) { pick = i; break; }
    }
    centroids.set(data.subarray(pick * d, pick * d + d), c * d);
  }

  const assign = new Int32Array(n).fill(-1);
  for (let iter = 0; iter < 14; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(data, i, centroids, c, d);
        if (dd < bestD) { bestD = dd; bestC = c; }
      }
      if (assign[i] !== bestC) { assign[i] = bestC; moved++; }
      if ((i & 2047) === 0) await yieldTick();
    }

    const sums = new Float64Array(k * d);
    const cnt = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assign[i], base = c * d, src = i * d;
      cnt[c]++;
      for (let kk = 0; kk < d; kk++) sums[base + kk] += data[src + kk];
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] === 0) continue;
      const base = c * d;
      for (let kk = 0; kk < d; kk++) centroids[base + kk] = sums[base + kk] / cnt[c];
    }

    if (moved / n < 0.001) break;
  }

  return { assign, centroids };
}

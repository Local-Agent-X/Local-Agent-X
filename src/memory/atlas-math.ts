// Pure math for the memory atlas layout: a seeded Johnson–Lindenstrauss random
// projection (cuts 1024-dim embeddings to a cheap working dimension), power
// iteration to pull the top-3 principal components for a 3D layout, and an
// evenly-spaced color palette. Seeded throughout so the same memories land in
// the same place across recomputes (stable layout, no UMAP-style reshuffle).

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// dIn×dOut gaussian matrix, scaled so projected vectors keep comparable norms.
export function makeJL(dIn: number, dOut: number, seed: number): Float32Array {
  const rng = makeRng(seed);
  const m = new Float32Array(dIn * dOut);
  const scale = 1 / Math.sqrt(dOut);
  for (let i = 0; i < m.length; i++) m[i] = gaussian(rng) * scale;
  return m;
}

// Project one input vector through the JL matrix into `out` (length dOut).
export function project(vec: number[], jl: Float32Array, dIn: number, dOut: number, out: Float32Array): void {
  for (let j = 0; j < dOut; j++) out[j] = 0;
  for (let i = 0; i < dIn; i++) {
    const v = vec[i];
    if (v === 0) continue;
    const base = i * dOut;
    for (let j = 0; j < dOut; j++) out[j] += v * jl[base + j];
  }
}

// Top-3 eigenvectors of a dim×dim covariance matrix via power iteration with
// Gram–Schmidt deflation. dim is small (the JL working dimension), so this is
// cheap and dependency-free.
export function topEigenvectors(cov: Float64Array, dim: number, seed: number): Float64Array[] {
  const rng = makeRng(seed);
  const vecs: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    let v = new Float64Array(dim);
    for (let i = 0; i < dim; i++) v[i] = rng() - 0.5;
    orthonormalize(v, vecs, dim);
    for (let iter = 0; iter < 60; iter++) {
      const w = new Float64Array(dim);
      for (let a = 0; a < dim; a++) {
        let s = 0;
        const row = a * dim;
        for (let b = 0; b < dim; b++) s += cov[row + b] * v[b];
        w[a] = s;
      }
      orthonormalize(w, vecs, dim);
      v = w;
    }
    vecs.push(v);
  }
  return vecs;
}

function orthonormalize(v: Float64Array, basis: Float64Array[], dim: number): void {
  for (const b of basis) {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += v[i] * b[i];
    for (let i = 0; i < dim; i++) v[i] -= dot * b[i];
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
}

// k evenly-spaced, readable hues → [r,g,b] 0-255.
export function palette(k: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i++) {
    const h = (i * 0.618033988749895) % 1; // golden-ratio spacing avoids adjacent clashes
    out.push(hslToRgb(h, 0.62, 0.62));
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const STOPWORDS = new Set(
  ("the a an and or but if then of to in on at for with from by is are was were be been being this that these those i you he she it we they me my your our their as so do does did not no yes can will just like get got about there here what which who when where how all any some more most other into over also new use used using one two it's i'm don't").split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

// Structural tokens from the memory format itself (every chunk is a user/
// assistant exchange) — so common they swamp TF-IDF; excluded outright.
const CORPUS_STOP = new Set(
  "user assistant chat concise conversation message messages session reply response model system human".split(" "),
);

// Class-based TF-IDF (the BERTopic trick): a term labels a cluster only if it's
// frequent *inside* it and rare *across* clusters. We also drop any term that
// shows up in more than ~60% of clusters — corpus-wide structural noise whose
// term-frequency is high enough to beat the IDF penalty otherwise.
export function labelClusters(buckets: Array<Map<string, number>>, topN: number): string[] {
  const k = buckets.length;
  const df = new Map<string, number>();
  for (const b of buckets) for (const term of b.keys()) df.set(term, (df.get(term) || 0) + 1);
  const maxDf = Math.max(2, Math.floor(k * 0.6));

  return buckets.map((b) => {
    let total = 0;
    for (const c of b.values()) total += c;
    if (total === 0) return "misc";
    const scored = [...b.entries()]
      .filter(([term]) => !CORPUS_STOP.has(term) && (df.get(term) || 0) <= maxDf)
      .map(([term, count]) => {
        const tf = count / total;
        const idf = Math.log(1 + k / (df.get(term) || 1));
        return [term, tf * idf] as [string, number];
      });
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, topN).map((e) => e[0]).join(" · ") || "misc";
  });
}

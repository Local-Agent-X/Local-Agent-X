// Warps the raw PCA projection into a brain silhouette while preserving cluster
// structure. We rasterize the 🧠 emoji once and measure, per angle around its
// center, how far the outline reaches (maxR). Each projected point keeps its
// angle but has its radius remapped to fill that angular slice — so clusters
// stay where they are angularly, but the overall envelope becomes a brain.

const BINS = 240;
const WORLD = 1.35;
let maxR = null;

function ensureRadial() {
  if (maxR) return;
  const SIZE = 420;
  const cv = document.createElement('canvas');
  cv.width = SIZE;
  cv.height = SIZE;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';
  cx.font = '340px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText('🧠', SIZE / 2, SIZE / 2);
  const data = cx.getImageData(0, 0, SIZE, SIZE).data;

  let minX = SIZE, minY = SIZE, maxX = 0, maxY = 0;
  const pts = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (data[(y * SIZE + x) * 4 + 3] > 90) {
        pts.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const ccx = (minX + maxX) / 2;
  const ccy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 || 1;

  maxR = new Float32Array(BINS);
  for (let i = 0; i < pts.length; i += 2) {
    const dx = (pts[i] - ccx) / half;
    const dy = -(pts[i + 1] - ccy) / half; // world Y is up
    const r = Math.hypot(dx, dy);
    let bin = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
    if (bin < 0) bin += BINS;
    if (r > maxR[bin]) maxR[bin] = r;
  }
  // Fill any empty angular bins from the nearest populated neighbor.
  for (let i = 0; i < BINS; i++) {
    if (maxR[i] > 0) continue;
    let d = 1;
    while (d < BINS && maxR[(i - d + BINS) % BINS] === 0 && maxR[(i + d) % BINS] === 0) d++;
    maxR[i] = Math.max(maxR[(i - d + BINS) % BINS], maxR[(i + d) % BINS]);
  }
}

// Returns { xyz, warp } — the warped positions plus the single-point warp
// function (used to move cluster centroids into the same space).
export function buildBrainWarp(rawXyz, n) {
  ensureRadial();
  let gmax = 1e-6;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(rawXyz[i * 3], rawXyz[i * 3 + 1]);
    if (r > gmax) gmax = r;
  }
  const warp = (x, y, z) => {
    const r = Math.hypot(x, y);
    const th = Math.atan2(y, x);
    let bin = Math.floor(((th + Math.PI) / (2 * Math.PI)) * BINS) % BINS;
    if (bin < 0) bin += BINS;
    const target = (r / gmax) * maxR[bin] * WORLD;
    return [Math.cos(th) * target, Math.sin(th) * target, z * 0.6];
  };
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = warp(rawXyz[i * 3], rawXyz[i * 3 + 1], rawXyz[i * 3 + 2]);
    xyz[i * 3] = p[0];
    xyz[i * 3 + 1] = p[1];
    xyz[i * 3 + 2] = p[2];
  }
  return { xyz, warp };
}

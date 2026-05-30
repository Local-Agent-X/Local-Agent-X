// Generates brain-shaped particle positions by rasterizing the 🧠 emoji to an
// offscreen canvas and sampling its opaque pixels — the same pixel-sampling
// trick the voice sphere uses for emoji/text morphs. A distance transform on
// the silhouette inflates the flat shape into a rounded 3D volume (dots in the
// thick interior sit deep, dots near the outline stay flat), so the cloud
// reads as a brain from any rotation rather than a paper-thin cutout.

// Returns { pos: Float32Array(n*3), size: Float32Array(n), seed: Float32Array(n) }.
export function sampleBrain(n) {
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const seed = new Float32Array(n);

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
  const inside = new Uint8Array(SIZE * SIZE);
  const pts = [];
  let minX = SIZE, minY = SIZE, maxX = 0, maxY = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (data[(y * SIZE + x) * 4 + 3] > 90) {
        inside[y * SIZE + x] = 1;
        pts.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const count = pts.length / 2;
  if (count === 0) return fallbackBlob(pos, size, seed, n);

  const dist = edgeDistance(inside, SIZE);
  let maxD = 1;
  for (let i = 0; i < dist.length; i++) if (inside[i] && dist[i] > maxD) maxD = dist[i];

  const cxPx = (minX + maxX) / 2;
  const cyPx = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  const SCALE = 2.6 / extent;
  const DEPTH = 2.6 * 0.34; // volume depth ≈ a third of the width → rounded, not a slab
  const stride = count / n;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i * stride) % count;
    const px = pts[k * 2];
    const py = pts[k * 2 + 1];
    const half = DEPTH * Math.sqrt(dist[py * SIZE + px] / maxD); // domed depth profile
    pos[i * 3] = (px - cxPx) * SCALE + (Math.random() - 0.5) * SCALE * 0.7;
    pos[i * 3 + 1] = -(py - cyPx) * SCALE + (Math.random() - 0.5) * SCALE * 0.7; // canvas Y flipped
    pos[i * 3 + 2] = (Math.random() * 2 - 1) * half;
    size[i] = 0.5 + Math.random() * 0.7;
    seed[i] = Math.random();
  }
  return { pos, size, seed };
}

// Two-pass chamfer distance transform: distance from each interior pixel to the
// nearest non-silhouette pixel. Cheap (two linear sweeps) and smooth enough to
// drive the depth inflation.
function edgeDistance(inside, SIZE) {
  const d = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  const a = 1, b = 1.41421356;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) v = Math.min(v, d[i - SIZE] + a);
      if (x > 0 && y > 0) v = Math.min(v, d[i - SIZE - 1] + b);
      if (x < SIZE - 1 && y > 0) v = Math.min(v, d[i - SIZE + 1] + b);
      d[i] = v;
    }
  }
  for (let y = SIZE - 1; y >= 0; y--) {
    for (let x = SIZE - 1; x >= 0; x--) {
      const i = y * SIZE + x;
      if (d[i] === 0) continue;
      let v = d[i];
      if (x < SIZE - 1) v = Math.min(v, d[i + 1] + a);
      if (y < SIZE - 1) v = Math.min(v, d[i + SIZE] + a);
      if (x < SIZE - 1 && y < SIZE - 1) v = Math.min(v, d[i + SIZE + 1] + b);
      if (x > 0 && y < SIZE - 1) v = Math.min(v, d[i + SIZE - 1] + b);
      d[i] = v;
    }
  }
  return d;
}

// Soft elliptical volume if a platform renders no brain glyph — never blank.
function fallbackBlob(pos, size, seed, n) {
  for (let i = 0; i < n; i++) {
    let x, y, z;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    pos[i * 3] = x * 1.3;
    pos[i * 3 + 1] = y * 1.0;
    pos[i * 3 + 2] = z * 0.8;
    size[i] = 0.5 + Math.random() * 0.6;
    seed[i] = Math.random();
  }
  return { pos, size, seed };
}

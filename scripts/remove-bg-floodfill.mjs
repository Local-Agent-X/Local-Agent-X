// Flood-fill background remover. Works when the background is a uniform
// color (the JPG renders from the AI image tool fit this). Unlike a U-Net
// model (rembg), this only removes pixels reachable from the canvas edges,
// so dark parts of the subject can't accidentally get eaten — the inside
// of the icon shape is structurally protected.
//
// Usage: node scripts/remove-bg-floodfill.mjs <input> <output> [tolerance]

import sharp from "sharp";

const SRC = process.argv[2];
const OUT = process.argv[3];
const TOLERANCE = Number(process.argv[4] || 24);

if (!SRC || !OUT) {
  console.error("usage: node remove-bg-floodfill.mjs <input> <output> [tolerance=24]");
  process.exit(1);
}

const img = sharp(SRC);
const meta = await img.metadata();
const { width, height } = meta;
const channels = meta.channels;
const raw = await img.raw().toBuffer();

// Background reference color = top-left corner pixel
const bgR = raw[0], bgG = raw[1], bgB = raw[2];
const TOL2 = TOLERANCE * TOLERANCE;

const visited = new Uint8Array(width * height);
const alpha = new Uint8Array(width * height);
alpha.fill(255);
const stack = [];

function tryPush(x, y) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const idx = y * width + x;
  if (visited[idx]) return;
  const px = idx * channels;
  const dr = raw[px] - bgR, dg = raw[px + 1] - bgG, db = raw[px + 2] - bgB;
  if (dr * dr + dg * dg + db * db > TOL2) return;
  visited[idx] = 1;
  alpha[idx] = 0;
  stack.push(idx);
}

// Seed from every edge pixel so the flood-fill starts wherever the
// background touches the canvas border.
for (let x = 0; x < width; x++) { tryPush(x, 0); tryPush(x, height - 1); }
for (let y = 0; y < height; y++) { tryPush(0, y); tryPush(width - 1, y); }

while (stack.length) {
  const idx = stack.pop();
  const x = idx % width;
  const y = (idx - x) / width;
  tryPush(x - 1, y); tryPush(x + 1, y);
  tryPush(x, y - 1); tryPush(x, y + 1);
}

// Compose RGBA output
const rgba = Buffer.alloc(width * height * 4);
for (let i = 0; i < width * height; i++) {
  const px = i * channels;
  rgba[i * 4] = raw[px];
  rgba[i * 4 + 1] = raw[px + 1];
  rgba[i * 4 + 2] = raw[px + 2];
  rgba[i * 4 + 3] = alpha[i];
}

await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(OUT);

const removed = alpha.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
const pct = (removed / (width * height) * 100).toFixed(1);
console.log(`wrote ${OUT} — removed ${removed} px (${pct}% of canvas) at tol=${TOLERANCE}`);

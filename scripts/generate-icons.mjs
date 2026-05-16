// Regenerate the desktop + browser icons from a single source image.
// Run: node scripts/generate-icons.mjs [<source-image>]
// Default source: public/icon-src.png
//
// Output:
//   - public/icon.png      (1024x1024, runtime icon + Mac icon source —
//                           electron-builder generates .icns from it at build time)
//   - public/icon.ico      (multi-resolution 16/24/32/48/64/128/256 for the
//                           Windows NSIS installer and runtime window icon)
//   - public/favicon.png   (192x192, browser tab + PWA shortcut)
//   - public/favicon.ico   (multi-resolution 16/24/32/48, browser tab fallback)

import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = process.argv[2] || "public/icon-src.png";
const OUT_PNG = "public/icon.png";
const OUT_ICO = "public/icon.ico";
const OUT_FAVICON_PNG = "public/favicon.png";
const OUT_FAVICON_ICO = "public/favicon.ico";

// Fallback crop region for the legacy 784x1168 JPG sources (DFTMC.jpg /
// x5Uf8.jpg) where there's no alpha channel to bbox by. Centered on the
// rounded-square icon with even margins.
const FALLBACK_CROP = { left: 32, top: 245, width: 720, height: 720 };
const ALPHA_THRESHOLD = 16;

// Find the bounding box of opaque content in a transparent image.
async function alphaBoundingBox(srcPath) {
  const { data, info } = await sharp(srcPath).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function main() {
  const meta = await sharp(resolve(SRC)).metadata();

  // Two pipelines:
  //   - Transparent source: alpha-bbox the icon, square-pad to its longest
  //     edge, resize to 1024x1024. Output keeps transparency edge-to-edge.
  //   - Opaque source: fixed JPG crop region, resize to 1024x1024.
  let pipeline;
  if (meta.hasAlpha) {
    const bbox = await alphaBoundingBox(resolve(SRC));
    const side = Math.max(bbox.width, bbox.height);
    const padX = Math.floor((side - bbox.width) / 2);
    const padY = Math.floor((side - bbox.height) / 2);
    console.log(`bbox ${bbox.width}x${bbox.height} → square ${side}x${side} (pad ${padX},${padY})`);
    pipeline = sharp(resolve(SRC))
      .extract(bbox)
      .extend({
        top: padY,
        bottom: side - bbox.height - padY,
        left: padX,
        right: side - bbox.width - padX,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .resize(1024, 1024, { kernel: "lanczos3" });
  } else {
    pipeline = sharp(resolve(SRC))
      .extract(FALLBACK_CROP)
      .resize(1024, 1024, { kernel: "lanczos3" });
  }

  const sq = await pipeline.png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(OUT_PNG), sq);
  console.log(`wrote ${OUT_PNG} (1024x1024, alpha=${!!meta.hasAlpha}, ${sq.length} bytes)`);

  // Windows .ico — embed every size from 16 up to 256 so File Explorer and
  // taskbar pick a crisp variant at any DPI.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(
    sizes.map((sz) =>
      sharp(sq).resize(sz, sz, { kernel: "lanczos3" }).png().toBuffer()
    )
  );
  const icoBuf = await pngToIco(pngs);
  writeFileSync(resolve(OUT_ICO), icoBuf);
  console.log(`wrote ${OUT_ICO} (${sizes.length} sizes, ${icoBuf.length} bytes)`);

  // Favicon — same source, scaled down. Browser tabs typically render at
  // 16-32px, PWA shortcut at 192px.
  const favPng = await sharp(sq).resize(192, 192, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(OUT_FAVICON_PNG), favPng);
  console.log(`wrote ${OUT_FAVICON_PNG} (192x192, ${favPng.length} bytes)`);

  const favSizes = [16, 24, 32, 48];
  const favPngs = await Promise.all(
    favSizes.map((sz) => sharp(sq).resize(sz, sz, { kernel: "lanczos3" }).png().toBuffer())
  );
  const favIcoBuf = await pngToIco(favPngs);
  writeFileSync(resolve(OUT_FAVICON_ICO), favIcoBuf);
  console.log(`wrote ${OUT_FAVICON_ICO} (${favSizes.length} sizes, ${favIcoBuf.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

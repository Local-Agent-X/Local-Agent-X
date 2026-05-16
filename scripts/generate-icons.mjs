// Regenerate public/icon.png + public/icon.ico from a source image.
// Run: node scripts/generate-icons.mjs <source-image>
// Default source: public/DFTMC.jpg (the noir-agent icon).
//
// Output:
//   - public/icon.png  (1024x1024, used at runtime + as the Mac icon source —
//                       electron-builder generates .icns from it at build time)
//   - public/icon.ico  (multi-resolution 16/24/32/48/64/128/256, used by the
//                       Windows NSIS installer and runtime window icon)

import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = process.argv[2] || "public/DFTMC.jpg";
const OUT_PNG = "public/icon.png";
const OUT_ICO = "public/icon.ico";

// Crop region tuned for public/DFTMC.jpg (784x1168 source). Captures the
// rounded-square icon with a few pixels of dark margin so the squircle's
// corners don't get sliced by macOS's own icon mask.
const CROP = { left: 32, top: 245, width: 720, height: 720 };

async function main() {
  const sq = await sharp(resolve(SRC))
    .extract(CROP)
    .resize(1024, 1024, { kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(OUT_PNG), sq);
  console.log(`wrote ${OUT_PNG} (1024x1024, ${sq.length} bytes)`);

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

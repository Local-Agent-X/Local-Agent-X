/**
 * Copy the non-TypeScript assets the server resolves beside its own modules
 * from the source tree into dist/ after tsc, which emits .js only:
 *   - src/protocols/bundled   the vendored SKILL.md protocol bodies
 *                             (src/protocols/loader.ts bundledProtocolsDir)
 *   - src/app-scaffold/kit    the structure kit dropped into built projects
 *                             (src/app-scaffold/kit-files.ts)
 * Without this step the compiled server would find each dir empty and throw on
 * first use. Non-fatal by design: a failed copy must not block install — the
 * desktop's freshness gate falls back to tsx-from-source, which reads src/.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIRS = [
  ["src", "protocols", "bundled"],
  ["src", "app-scaffold", "kit"],
];

for (const parts of ASSET_DIRS) {
  const src = join(REPO_ROOT, ...parts);
  const dest = join(REPO_ROOT, "dist", ...parts.slice(1));
  try {
    if (!existsSync(src)) {
      console.warn(`[copy-bundled-assets] source missing: ${src} — nothing to copy`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    console.log(`[copy-bundled-assets] ${src} → ${dest}`);
  } catch (err) {
    console.warn(`[copy-bundled-assets] copy failed (dist will fall back to tsx-from-source): ${err?.message ?? err}`);
  }
}

/**
 * Copy the vendored bundled-protocol SKILL.md bodies from the source tree into
 * dist/ after tsc. tsc only emits .js — it ignores .md — so without this step
 * the compiled server (which resolves the dir relative to its own location)
 * would find dist/protocols/bundled empty and throw on first loadSkillBody.
 *
 * Source of truth for the path is src/protocols/loader.ts (bundledProtocolsDir);
 * this script mirrors src/protocols/bundled → dist/protocols/bundled verbatim.
 * Non-fatal by design: a failed copy must not block install — the desktop's
 * freshness gate falls back to tsx-from-source, which reads straight from src/.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src", "protocols", "bundled");
const DEST = join(REPO_ROOT, "dist", "protocols", "bundled");

try {
  if (!existsSync(SRC)) {
    console.warn(`[copy-bundled-protocols] source missing: ${SRC} — nothing to copy`);
  } else {
    mkdirSync(dirname(DEST), { recursive: true });
    cpSync(SRC, DEST, { recursive: true });
    console.log(`[copy-bundled-protocols] ${SRC} → ${DEST}`);
  }
} catch (err) {
  console.warn(`[copy-bundled-protocols] copy failed (dist will fall back to tsx-from-source): ${err?.message ?? err}`);
}

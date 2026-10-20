/**
 * Where the vendored structure kit lives and what one command runs it. The kit
 * (`kit/`) is a copy of the /new-project skill's scripts, kept equal to it by
 * scripts/check-kit-sync.mjs; nothing here edits it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve relative to this module, not process.cwd(): src/app-scaffold/kit in
// dev, dist/app-scaffold/kit in prod (scripts/copy-bundled-assets.mjs).
const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "kit");

/** The entry the project's build and the harness gates run. */
export const STRUCTURE_CHECK_SCRIPT = "scripts/check-structure.mjs";
export const STRUCTURE_CHECK_COMMAND = `node ${STRUCTURE_CHECK_SCRIPT}`;

/** The framework creator's docs the doc-path check skips until edited; the
 *  check reads it beside itself (kit/check-doc-paths.mjs header). */
export const STOCK_DOCS_MANIFEST = "scripts/doc-paths-stock.json";

/** The scripts every kit project gets, by their name under its scripts/: every
 *  script the sync vendors. The one list is scripts/check-kit-sync.mjs KIT_FILES;
 *  the sync records it in kit/UPSTREAM.json, read here. */
export const KIT_SCRIPTS: readonly string[] = Object.keys(
  JSON.parse(readFileSync(join(KIT_DIR, "UPSTREAM.json"), "utf-8")) as Record<string, unknown>,
).filter((name) => name.endsWith(".mjs"));

/** The module-seal test templates (vitest, pytest), stored with a .txt suffix
 *  so neither is ever this repo's test. */
export const KIT_SEAL_TEST = "module-seals.test.ts.txt";
export const KIT_SEAL_TEST_PY = "test_module_seals.py.txt";

export function readKitFile(name: string): string {
  return readFileSync(join(KIT_DIR, name), "utf-8");
}

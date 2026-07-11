// Import-purity contract for config.ts: importing the module must have NO
// side effects — no config/app-manifest.json write, no watcher start, no
// data-dir touch. Those effects live in the explicit initConfig() that the
// boot path (src/index.ts) calls once. Real modules here (no vi.mock) so a
// reintroduced top-level call in config.ts or anything in its import graph
// fails this test via the filesystem itself; the initConfig() behavioral
// contract (calls + idempotence) lives in config-init.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, statSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Same derivation as src/manifest-generator/paths.ts: repo root is one level
// up from src/, and the manifest lands in <root>/config/app-manifest.json.
const MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "app-manifest.json",
);

describe("config.ts import purity", () => {
  let laxDir: string;
  let prevLaxDir: string | undefined;

  beforeEach(() => {
    prevLaxDir = process.env.LAX_DATA_DIR;
    laxDir = mkdtempSync(join(tmpdir(), "lax-config-purity-"));
    process.env.LAX_DATA_DIR = laxDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prevLaxDir;
    rmSync(laxDir, { recursive: true, force: true });
  });

  it("importing config.js writes no manifest and touches no data dir", async () => {
    const hadManifest = existsSync(MANIFEST_PATH);
    const mtimeBefore = hadManifest ? statSync(MANIFEST_PATH).mtimeMs : null;

    const mod = await import("./config.js");

    // The manifest must be exactly as it was: absent stays absent, and a
    // pre-existing one (a prior real boot in this checkout) is not rewritten.
    expect(existsSync(MANIFEST_PATH)).toBe(hadManifest);
    if (mtimeBefore !== null) {
      expect(statSync(MANIFEST_PATH).mtimeMs).toBe(mtimeBefore);
    }

    // Import alone must not create anything under the LAX data dir either
    // (getConfigDir/loadConfig are lazy — only explicit calls may write).
    expect(readdirSync(laxDir)).toEqual([]);

    // The explicit init hook is the module's replacement for the old
    // top-level calls; it must exist so the boot path can invoke it.
    expect(typeof mod.initConfig).toBe("function");
  });
});

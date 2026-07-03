/**
 * Regression suite for the removal of the dead tiered-memory store (CM-9).
 *
 * The `MemoryTierManager` in src/memory-tiers.ts was a parallel memory store
 * that violated the repo's "no second memory store" invariant. Its ingestion
 * API (addMemory / searchTiered / deepRecall) had ZERO production callers, so
 * the store was permanently empty — yet `reclassifyAll` ran daily from the
 * background runner and re-persisted an empty ~/.lax/memory-tiers.json, which
 * also rode the sync manifest (BRAIN_JSON_FILES). The decision was to DELETE
 * the store outright.
 *
 * This suite pins the post-deletion invariants and FAILS on the pre-deletion
 * code:
 *   (a) src/memory-tiers.ts no longer exists and nothing under src/ imports the
 *       `memory-tiers.js` module (pre-deletion: background-runner.ts and
 *       signals-background.ts both import it).
 *   (b) BRAIN_JSON_FILES no longer lists "memory-tiers.json", so the empty file
 *       stops riding the sync manifest (pre-deletion: it was in the list).
 *   (c) The one-time migration removes a stale ~/.lax/memory-tiers.json left on
 *       OTA-updated installs (pre-deletion: no such migration existed, so a
 *       pre-seeded file survives runMigrations).
 *
 * The migration probe resolves the data dir through getLaxDir() at call time,
 * which honors LAX_DATA_DIR — we point it at a fresh temp dir per test and give
 * each test a clean module (vi.resetModules) so module-level migration state
 * starts empty.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "src");

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules") continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("dead memory-tiers store is fully removed (CM-9)", () => {
  it("(a) src/memory-tiers.ts does not exist and no src file imports the module", () => {
    expect(existsSync(join(SRC_DIR, "memory-tiers.ts"))).toBe(false);

    // A module import of the deleted store references the specifier
    // `memory-tiers.js` closed by a quote — matching that (rather than a bare
    // substring) avoids flagging the "memory-tiers.json" filename that appears
    // in the migration's comment/string.
    const importSpecifier = /memory-tiers\.js["']/;
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_DIR)) {
      const src = readFileSync(file, "utf-8");
      if (importSpecifier.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("(b) BRAIN_JSON_FILES no longer lists memory-tiers.json", async () => {
    const { BRAIN_JSON_FILES } = await import("../src/sync/constants.js");
    expect(BRAIN_JSON_FILES as readonly string[]).not.toContain("memory-tiers.json");
  });
});

describe("startup migration unlinks the stale memory-tiers.json (CM-9)", () => {
  const tmpDirs: string[] = [];
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cm9-memory-tiers-"));
    tmpDirs.push(dataDir);
    process.env.LAX_DATA_DIR = dataDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.LAX_DATA_DIR;
  });

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("deletes a pre-existing stale file on runMigrations", async () => {
    const stalePath = join(dataDir, "memory-tiers.json");
    writeFileSync(stalePath, JSON.stringify({ records: {}, lastReclassify: 0 }), "utf-8");
    expect(existsSync(stalePath)).toBe(true);

    const { runMigrations } = await import("../src/db-migrations.js");
    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    expect(existsSync(stalePath)).toBe(false);
  });

  it("is a no-op when the stale file is absent", async () => {
    const stalePath = join(dataDir, "memory-tiers.json");
    expect(existsSync(stalePath)).toBe(false);

    const { runMigrations } = await import("../src/db-migrations.js");
    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    expect(existsSync(stalePath)).toBe(false);
  });
});

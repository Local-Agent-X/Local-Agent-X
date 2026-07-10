/**
 * Regression suite for isolated-by-default browser contexts.
 *
 * The old default was a shared browser context (one cookie jar for every
 * session). The default flipped: each session now gets its own context, with
 * the settings toggle remaining as the opt-out back to shared continuity.
 * This pins:
 *   (a) the schema default for browserPerSessionContext is true, and
 *   (b) migration v4 flips a persisted browserPerSessionContext=false (left
 *       behind by the old default) to true, while leaving other config keys
 *       untouched and no-oping when the key is already true or absent.
 *
 * The migration resolves the data dir through getLaxDir() at call time, which
 * honors LAX_DATA_DIR — we point it at a fresh temp dir per test and give each
 * test a clean module (vi.resetModules) so migration state starts empty.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("browserPerSessionContext schema default", () => {
  it("defaults to true (isolated per-session contexts)", async () => {
    const { configSchema } = await import("../src/config-schema.js");
    const parsed = configSchema.parse({});
    expect(parsed.browserPerSessionContext).toBe(true);
  });
});

describe("migration v4 flips persisted browserPerSessionContext=false to true", () => {
  const tmpDirs: string[] = [];
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "browser-ctx-default-"));
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

  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"));
  }

  it("flips false to true and preserves the rest of the config", async () => {
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ browserPerSessionContext: false, browserCdpPort: 9911 }),
      "utf-8",
    );

    const { runMigrations } = await import("../src/db-migrations.js");
    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    const cfg = readConfig();
    expect(cfg.browserPerSessionContext).toBe(true);
    expect(cfg.browserCdpPort).toBe(9911);
  });

  it("leaves an already-true value alone", async () => {
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ browserPerSessionContext: true }),
      "utf-8",
    );

    const { runMigrations } = await import("../src/db-migrations.js");
    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    expect(readConfig().browserPerSessionContext).toBe(true);
  });

  it("is a no-op when config.json is absent", async () => {
    const { runMigrations } = await import("../src/db-migrations.js");
    const result = await runMigrations(dataDir);

    expect(result.error).toBeUndefined();
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);
  });
});

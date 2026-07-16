// Regression contract for saveConfig(): config.json has more than one
// writer. The desktop shell persists keys the server's LAXConfig doesn't
// know about (projectRoot — which decides where the shell loads code from),
// so a settings save serializing only the runtime object silently severed
// the app from the user's dev repo (burned 2026-07-15). saveConfig must
// merge over the on-disk JSON: unknown keys survive, server-known keys take
// the runtime value.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "./config.js";
import type { LAXConfig } from "./types.js";

describe("saveConfig() foreign-key preservation", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let configPath: string;

  beforeAll(() => {
    previousDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "config-save-"));
    process.env.LAX_DATA_DIR = dataDir;
    configPath = join(dataDir, "config.json");
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function runtimeConfig(overrides: Partial<LAXConfig> = {}): LAXConfig {
    return { port: 7007, authToken: "test-token", model: "test-model", ...overrides } as LAXConfig;
  }

  it("preserves desktop-owned keys the runtime config does not carry", () => {
    writeFileSync(configPath, JSON.stringify({
      port: 7007,
      authToken: "test-token",
      projectRoot: "C:\\Users\\someone\\local-agent-x",
    }, null, 2));

    saveConfig(runtimeConfig({ model: "changed-model" }));

    const disk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(disk.projectRoot).toBe("C:\\Users\\someone\\local-agent-x");
    expect(disk.model).toBe("changed-model");
  });

  it("runtime values win over stale disk values for server-known keys", () => {
    writeFileSync(configPath, JSON.stringify({
      port: 7007,
      authToken: "old-token",
      model: "old-model",
      projectRoot: "/some/repo",
    }, null, 2));

    saveConfig(runtimeConfig({ authToken: "new-token" }));

    const disk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(disk.authToken).toBe("new-token");
    expect(disk.projectRoot).toBe("/some/repo");
  });

  it("still writes when config.json is missing or corrupt", () => {
    writeFileSync(configPath, "{not json");

    saveConfig(runtimeConfig());

    const disk = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(disk.model).toBe("test-model");

    rmSync(configPath);
    saveConfig(runtimeConfig({ model: "after-missing" }));
    expect(JSON.parse(readFileSync(configPath, "utf-8")).model).toBe("after-missing");
  });
});

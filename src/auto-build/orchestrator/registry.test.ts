import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAll, register } from "./registry.js";

describe("active orchestrator registry durability", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "orchestrator-registry-"));
    process.env.LAX_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns true only after the entry is durably readable", () => {
    const entry = {
      projectDir: join(dataDir, "project"),
      opId: "op_registry",
      sessionId: "registry-session",
      registeredAt: new Date().toISOString(),
    };

    expect(register(entry)).toBe(true);
    expect(listAll()).toEqual([entry]);
  });

  it("returns false when the registry path cannot be written", () => {
    const blockedDataDir = join(dataDir, "not-a-directory");
    writeFileSync(blockedDataDir, "file");
    process.env.LAX_DATA_DIR = blockedDataDir;

    expect(register({
      projectDir: join(dataDir, "project"),
      opId: "op_registry_failure",
      sessionId: "registry-session",
      registeredAt: new Date().toISOString(),
    })).toBe(false);
  });
});

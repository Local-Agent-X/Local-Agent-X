// The scratch folder follows the data folder in force when it is asked for.
// Seven modules used to work it out at import, each on its own, so a data
// folder set later (an isolated server, a test) still got their files in the
// first one.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpPath, voiceTmpDir } from "./paths.js";

describe("voice scratch folder", () => {
  const before = process.env.LAX_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-voice-paths-"));
    process.env.LAX_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = before;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is under the data folder set after this module was imported, and exists", () => {
    const dir = voiceTmpDir();
    expect(dir).toBe(join(dataDir, "voice-tmp"));
    expect(existsSync(dir)).toBe(true);
  });

  it("hands out a new path there each time, named for the caller", () => {
    const a = tmpPath("wav", "cam_");
    const b = tmpPath("wav", "cam_");
    expect(dirname(a)).toBe(join(dataDir, "voice-tmp"));
    expect(basename(a)).toMatch(/^cam_[0-9a-f]{12}\.wav$/);
    expect(a).not.toBe(b);
    expect(basename(tmpPath("py"))).toMatch(/^[0-9a-f]{12}\.py$/);
  });
});

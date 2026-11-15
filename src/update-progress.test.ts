import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginUpdateProgress, endUpdateProgress, promoteToInstalling, recordBuildDuration, updateProgress, updateStep } from "./update-progress.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-progress-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
  endUpdateProgress();
  if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("update progress", () => {
  it("is idle with nothing running, and full when an update is ready", () => {
    expect(updateProgress(false)).toMatchObject({ mode: "idle", percent: 0 });
    expect(updateProgress(true)).toMatchObject({ mode: "ready", percent: 100 });
  });

  it("moves through the steps in order and never goes backwards", () => {
    const t = 1_000_000;
    beginUpdateProgress("installing", t);
    updateStep("fetch", t);
    const p1 = updateProgress(false, t + 1_000).percent;
    updateStep("copy", t + 2_000);
    updateStep("build", t + 3_000);
    const p2 = updateProgress(false, t + 3_000).percent;
    expect(p2).toBeGreaterThan(p1);
    // A skipped dependency step hands its share over: the build starts past it.
    expect(p2).toBe(5 + 3 + 15);
    updateStep("copy", t + 4_000);
    expect(updateProgress(false, t + 4_000).percent).toBeGreaterThanOrEqual(p2);
  });

  it("advances inside the build by this machine's last build time, but never past 90 % of its share", () => {
    recordBuildDuration(10_000);
    const t = 2_000_000;
    beginUpdateProgress("installing", t);
    updateStep("build", t);
    expect(updateProgress(false, t + 5_000).percent).toBe(Math.round(23 + 55 * 0.5));
    expect(updateProgress(false, t + 60_000).percent).toBe(Math.round(23 + 55 * 0.9));
  });

  it("reports an install once a click joins a background preparation", () => {
    beginUpdateProgress("preparing");
    expect(updateProgress(false).mode).toBe("preparing");
    promoteToInstalling();
    expect(updateProgress(false).mode).toBe("installing");
  });
});

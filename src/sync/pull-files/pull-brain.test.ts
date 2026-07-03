import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullBrainJsonFiles } from "./pull-brain.js";
import type { SyncConfig } from "../constants.js";

// Seam: sync pull → non-merged brain JSON files. SV-3 regression — files not
// in MERGED_BRAIN_FILES were overwritten wholesale from remote with no mtime
// guard. Because the heartbeat pulls THEN pushes, a locally-written-but-not-
// yet-pushed file (a fresh milestone) was clobbered by the older remote copy
// and the loss made permanent by the follow-up push.
describe("pullBrainJsonFiles — mtime guard on non-merged brain files", () => {
  let dataDir: string;
  let syncDir: string;
  const config = { syncMissions: true } as SyncConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-brain-data-"));
    syncDir = mkdtempSync(join(tmpdir(), "lax-brain-sync-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(syncDir, { recursive: true, force: true });
  });

  // milestones.json is a non-merged BRAIN_JSON_FILE (not in MERGED_BRAIN_FILES).
  const NAME = "milestones.json";

  it("preserves a locally-newer file against a stale remote (SV-3)", () => {
    const remotePath = join(syncDir, NAME);
    const localPath = join(dataDir, NAME);

    // Remote copy is OLDER; local copy holds a fresh, not-yet-pushed milestone.
    writeFileSync(remotePath, JSON.stringify({ note: "old-remote" }), "utf-8");
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(remotePath, oldTime, oldTime);

    writeFileSync(localPath, JSON.stringify({ note: "fresh-local" }), "utf-8");
    // ensure local mtime is strictly newer than remote
    const newTime = new Date();
    utimesSync(localPath, newTime, newTime);

    pullBrainJsonFiles(dataDir, syncDir, config);

    expect(JSON.parse(readFileSync(localPath, "utf-8")).note).toBe("fresh-local");
  });

  it("still pulls a newer remote over an older local", () => {
    const remotePath = join(syncDir, NAME);
    const localPath = join(dataDir, NAME);

    writeFileSync(localPath, JSON.stringify({ note: "old-local" }), "utf-8");
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(localPath, oldTime, oldTime);

    writeFileSync(remotePath, JSON.stringify({ note: "new-remote" }), "utf-8");
    const newTime = new Date();
    utimesSync(remotePath, newTime, newTime);

    pullBrainJsonFiles(dataDir, syncDir, config);

    expect(JSON.parse(readFileSync(localPath, "utf-8")).note).toBe("new-remote");
  });

  it("pulls when the file does not exist locally yet", () => {
    const remotePath = join(syncDir, NAME);
    const localPath = join(dataDir, NAME);
    writeFileSync(remotePath, JSON.stringify({ note: "remote-only" }), "utf-8");

    pullBrainJsonFiles(dataDir, syncDir, config);

    expect(existsSync(localPath)).toBe(true);
    expect(JSON.parse(readFileSync(localPath, "utf-8")).note).toBe("remote-only");
    // sanity: statSync works on the landed file
    expect(statSync(localPath).isFile()).toBe(true);
  });
});

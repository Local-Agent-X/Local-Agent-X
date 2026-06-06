/**
 * OTAManager — rolling-channel commit marker.
 *
 * Tarball installs have no git, so the rolling updater records the commit it
 * last applied and compares it to remote main HEAD. These cover the persisted
 * marker (the new state the non-git update path reads/writes). The network
 * (checkMainCommit/downloadMainTarball) and filesystem extract (applyUpdate)
 * are integration-level and exercised live, not here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTAManager } from "./ota-update.js";

let laxDir: string;
let ota: OTAManager;

beforeEach(() => {
  laxDir = mkdtempSync(join(tmpdir(), "lax-ota-"));
  ota = new OTAManager("Local-Agent-X", "Local-Agent-X", laxDir);
});

afterEach(() => {
  try { rmSync(laxDir, { recursive: true, force: true }); } catch {}
});

describe("OTAManager — installed commit marker", () => {
  it("returns null when no commit has been recorded", async () => {
    expect(await ota.readInstalledCommit()).toBeNull();
  });

  it("round-trips the recorded commit", async () => {
    const sha = "a1b2c3d4e5f600000000000000000000deadbeef";
    await ota.writeInstalledCommit(sha);
    expect(await ota.readInstalledCommit()).toBe(sha);
    expect(existsSync(join(laxDir, "installed-source.json"))).toBe(true);
  });

  it("overwrites a prior commit on the next apply", async () => {
    await ota.writeInstalledCommit("oldcommit");
    await ota.writeInstalledCommit("newcommit");
    expect(await ota.readInstalledCommit()).toBe("newcommit");
  });

  it("returns null for a corrupt marker rather than throwing", async () => {
    writeFileSync(join(laxDir, "installed-source.json"), "{not json", "utf-8");
    expect(await ota.readInstalledCommit()).toBeNull();
  });
});

describe("OTAManager — applyUpdate is userData-safe", () => {
  it("applies the update, backs up only overlapping source, and ignores install-only/special files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-ota-apply-"));
    const installDir = join(root, "install");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(installDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "src"), { recursive: true });

    // Install state: an overlapping source file (old content), an install-only
    // file, and a broken symlink standing in for Electron's SingletonLock —
    // the file that made the old whole-dir backup crash with copyfile ENOENT.
    writeFileSync(join(installDir, "src", "app.ts"), "OLD");
    writeFileSync(join(installDir, "keep.marker"), "keep me");
    symlinkSync("/nonexistent/target", join(installDir, "SingletonLock"));

    // Release payload (a single top dir so --strip-components=1 lands clean).
    writeFileSync(join(pkgDir, "src", "app.ts"), "NEW");
    writeFileSync(join(pkgDir, "added.txt"), "added");
    const tarPath = join(root, "rel.tar.gz");
    execFileSync("tar", ["czf", tarPath, "-C", root, "pkg"]);

    const m = new OTAManager("o", "r", join(root, "lax"));
    await expect(m.applyUpdate(tarPath, installDir, "v0")).resolves.toBeUndefined();

    // Update applied.
    expect(readFileSync(join(installDir, "src", "app.ts"), "utf-8")).toBe("NEW");
    expect(readFileSync(join(installDir, "added.txt"), "utf-8")).toBe("added");
    // Install-only + special files survived untouched (no crash).
    expect(readFileSync(join(installDir, "keep.marker"), "utf-8")).toBe("keep me");
    // lstat, not existsSync — the dangling symlink survived; existsSync would
    // follow it to the missing target and wrongly report false.
    expect(lstatSync(join(installDir, "SingletonLock")).isSymbolicLink()).toBe(true);

    // Backup holds the OLD overlapping source only — not the symlink/install-only.
    const backupRoot = join(root, "lax", "backups");
    const backupDir = join(backupRoot, readdirSync(backupRoot)[0]);
    expect(readFileSync(join(backupDir, "src", "app.ts"), "utf-8")).toBe("OLD");
    expect(existsSync(join(backupDir, "keep.marker"))).toBe(false);
    expect(existsSync(join(backupDir, "SingletonLock"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

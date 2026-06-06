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
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(laxDir, "installed-source.json"), "{not json", "utf-8");
    expect(await ota.readInstalledCommit()).toBeNull();
  });
});

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
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTAManager, assertSha256 } from "./ota-update.js";
import { resolveTarBinaries } from "./ota-extract.js";
import { createHash } from "node:crypto";
import { CAN_CREATE_FILE_SYMLINK } from "./symlink-capabilities.test-helper.js";

describe("resolveTarBinaries — extract must not depend on the inherited PATH", () => {
  // Field failure (Win11): the installed app inherited a PATH without
  // System32, so bare `tar` AND the old `powershell -Command tar …` fallback
  // (same PATH) both died with CommandNotFound and the update aborted. The
  // fix pins the first candidate to the absolute System32 bsdtar.
  it("puts absolute %SystemRoot%\\System32\\tar.exe first on Windows", () => {
    if (process.platform !== "win32") return;
    const sysTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (!existsSync(sysTar)) return; // pre-17063 host — nothing to pin
    expect(resolveTarBinaries()[0]).toBe(sysTar);
  });

  it("always ends with PATH `tar` as the final fallback", () => {
    const bins = resolveTarBinaries();
    expect(bins[bins.length - 1]).toBe("tar");
  });

  it("never emits a powershell candidate (it resolves through the same PATH)", () => {
    expect(resolveTarBinaries().some(b => /powershell/i.test(b))).toBe(false);
  });
});

describe("assertSha256 — rolling-channel bytes-level verify (round-8)", () => {
  const bytes = Buffer.from("synthetic source tarball bytes");
  const good = createHash("sha256").update(bytes).digest("hex");

  it("passes when the digest matches", () => {
    expect(() => assertSha256(bytes, good)).not.toThrow();
  });

  it("tolerates the `<hash>  filename` sha256sum shape", () => {
    expect(() => assertSha256(bytes, `${good}  lax-source-abc.tar.gz`)).not.toThrow();
  });

  it("throws on a mismatched digest (tampered bytes)", () => {
    expect(() => assertSha256(Buffer.from("tampered"), good)).toThrow(/checksum mismatch/);
  });

  it("throws on a malformed/empty published checksum (fails closed)", () => {
    expect(() => assertSha256(bytes, "not-a-hash")).toThrow(/malformed/);
    expect(() => assertSha256(bytes, "")).toThrow(/malformed/);
  });
});

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
  it("applies the update, backs up only overlapping source, and preserves install-only files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-ota-apply-"));
    const installDir = join(root, "install");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(installDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "src"), { recursive: true });

    // Install state: an overlapping source file and an install-only file.
    writeFileSync(join(installDir, "src", "app.ts"), "OLD");
    writeFileSync(join(installDir, "keep.marker"), "keep me");

    // Release payload (a single top dir so --strip-components=1 lands clean).
    writeFileSync(join(pkgDir, "src", "app.ts"), "NEW");
    writeFileSync(join(pkgDir, "added.txt"), "added");
    const tarPath = join(root, "rel.tar.gz");
    // Run from `root` with relative paths so no Windows drive-letter (`C:\…`)
    // reaches tar — GNU tar reads the colon in `czf C:\…` as a remote rsh host
    // ("Cannot connect to C:"). Relative names work for GNU tar and bsdtar alike.
    execFileSync("tar", ["czf", "rel.tar.gz", "pkg"], { cwd: root });

    const m = new OTAManager("o", "r", join(root, "lax"));
    await expect(
      m.applyUpdate(tarPath, installDir, "v0", "deadbeefcafebabe0000000000000000feedface")
    ).resolves.toEqual({ depsChanged: false });

    // Update applied.
    expect(readFileSync(join(installDir, "src", "app.ts"), "utf-8")).toBe("NEW");
    expect(readFileSync(join(installDir, "added.txt"), "utf-8")).toBe("added");
    // Install-only files survived untouched.
    expect(readFileSync(join(installDir, "keep.marker"), "utf-8")).toBe("keep me");

    // Backup holds the OLD overlapping source only — not the install-only file.
    const backupDir = join(root, "lax", "update-rollback", "artifacts");
    expect(readFileSync(join(backupDir, "src", "app.ts"), "utf-8")).toBe("OLD");
    expect(existsSync(join(backupDir, "keep.marker"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("ignores broken install-only symlinks during apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-ota-symlink-"));
    const installDir = join(root, "install");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(installDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(installDir, "src", "app.ts"), "OLD");
    writeFileSync(join(pkgDir, "src", "app.ts"), "NEW");
    symlinkSync(join(root, "missing-target"), join(installDir, "SingletonLock"));
    execFileSync("tar", ["czf", "rel.tar.gz", "pkg"], { cwd: root });

    const m = new OTAManager("o", "r", join(root, "lax"));
    await expect(
      m.applyUpdate(join(root, "rel.tar.gz"), installDir, "v0", "deadbeefcafebabe0000000000000000feedface")
    ).resolves.toEqual({ depsChanged: false });

    expect(lstatSync(join(installDir, "SingletonLock")).isSymbolicLink()).toBe(true);
    const backupDir = join(root, "lax", "update-rollback", "artifacts");
    expect(existsSync(join(backupDir, "SingletonLock"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("never copies node_modules over the install (loaded native modules stay put)", async () => {
    // Reproduces the EBUSY: a tarball that still carries node_modules (the
    // stuck-junction case) must not overwrite the install's deps — those
    // include native .node modules the running process holds loaded, which
    // Windows refuses to replace in place.
    const root = mkdtempSync(join(tmpdir(), "lax-ota-nm-"));
    const installDir = join(root, "install");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(installDir, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(pkgDir, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(pkgDir, "src"), { recursive: true });

    writeFileSync(join(installDir, "node_modules", "dep", "native.node"), "INSTALLED");
    writeFileSync(join(pkgDir, "node_modules", "dep", "native.node"), "FROM-TARBALL");
    writeFileSync(join(pkgDir, "src", "app.ts"), "NEW");
    const tarPath = join(root, "rel.tar.gz");
    // Run from `root` with relative paths so no Windows drive-letter (`C:\…`)
    // reaches tar — GNU tar reads the colon in `czf C:\…` as a remote rsh host
    // ("Cannot connect to C:"). Relative names work for GNU tar and bsdtar alike.
    execFileSync("tar", ["czf", "rel.tar.gz", "pkg"], { cwd: root });

    const m = new OTAManager("o", "r", join(root, "lax"));
    await m.applyUpdate(tarPath, installDir, "v0", "deadbeefcafebabe0000000000000000feedface");

    // Source applied; node_modules left exactly as installed (not overwritten).
    expect(readFileSync(join(installDir, "src", "app.ts"), "utf-8")).toBe("NEW");
    expect(readFileSync(join(installDir, "node_modules", "dep", "native.node"), "utf-8")).toBe("INSTALLED");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("OTAManager — rolling-channel integrity gate (R4-06)", () => {
  // applyUpdate is the single chokepoint that runs `tar xzf` + copyDirectory
  // over the live install dir. These assert no code path reaches that extract
  // without bytes bound to a resolved commit, and that the download is pinned
  // to the immutable per-commit archive rather than the mutable branch ref.

  it("applyUpdate REFUSES to extract bytes not bound to a resolved commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-ota-gate-"));
    const installDir = join(root, "install");
    const pkgDir = join(root, "pkg");
    mkdirSync(join(installDir, "src"), { recursive: true });
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(installDir, "src", "app.ts"), "OLD");
    writeFileSync(join(pkgDir, "src", "app.ts"), "NEW");
    const tarPath = join(root, "rel.tar.gz");
    // Run from `root` with relative paths so no Windows drive-letter (`C:\…`)
    // reaches tar — GNU tar reads the colon in `czf C:\…` as a remote rsh host
    // ("Cannot connect to C:"). Relative names work for GNU tar and bsdtar alike.
    execFileSync("tar", ["czf", "rel.tar.gz", "pkg"], { cwd: root });

    const m = new OTAManager("o", "r", join(root, "lax"));
    // Empty commit ⇒ no integrity binding ⇒ must throw BEFORE extracting.
    await expect(m.applyUpdate(tarPath, installDir, "v0", "")).rejects.toThrow(
      /no resolved commit/i
    );
    // The install file must be untouched — nothing was extracted over it.
    expect(readFileSync(join(installDir, "src", "app.ts"), "utf-8")).toBe("OLD");

    rmSync(root, { recursive: true, force: true });
  });

  it("downloadMainTarball REFUSES to fetch without a resolved commit", async () => {
    // Empty commit ⇒ no immutable URL to pin ⇒ must reject before any fetch.
    await expect(ota.downloadMainTarball("")).rejects.toThrow(/no resolved commit/i);
  });
});

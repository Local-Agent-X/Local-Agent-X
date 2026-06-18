/**
 * Regression lock for the Windows update-brick CLASS.
 *
 * The in-app Update button ran `npm ci` / recursive deletes inside a sandbox
 * (worktree or extract dir) whose node_modules is a junction back to the LIVE
 * install. When the junction survived isolation, the clean step traversed it
 * into the running install and tried to unlink a LOADED native module
 * (sqlite-vec's vec0.dll) → Windows EPERM, after a partial wipe = brick.
 *
 * Two pure guards now make the whole class structurally impossible. This file
 * locks both so they can't silently regress:
 *
 *   1. escapesSandbox — realpath-based proof that a node_modules link no longer
 *      reaches outside its sandbox. realpath follows a reparse point regardless
 *      of how lstat classifies it, so a junction lstat misreads as a plain dir
 *      (the exact Windows quirk) is still caught. Used by unlinkSharedJunctions
 *      and the boot orphan sweep; every destructive caller already refuses when
 *      a link is reported stuck.
 *   2. isDeferrableFileLock — distinguishes a Windows file lock (defer to
 *      next-launch reconcile) from a real dependency error (revert), so the git
 *      and rolling update paths defer identically instead of one bricking.
 *
 * Symlinks stand in for Windows junctions: realpath follows both the same way,
 * which is the property under test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapesSandbox, unlinkSharedJunctions } from "../src/agency/worktree-junctions.js";
import { isDeferrableFileLock } from "../src/update-pipeline.js";

describe("escapesSandbox — the junction-traversal guard", () => {
  let root: string, install: string, installNm: string, sandbox: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-brick-"));
    install = join(root, "install");
    installNm = join(install, "node_modules");
    sandbox = join(root, "sandbox");
    mkdirSync(join(installNm, "sqlite-vec"), { recursive: true });
    writeFileSync(join(installNm, "sqlite-vec", "vec0.dll"), "loaded-native-module");
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("flags a node_modules link that resolves into the live install", () => {
    symlinkSync(installNm, join(sandbox, "node_modules"), "dir");
    expect(escapesSandbox(join(sandbox, "node_modules"), sandbox)).toBe(true);
  });

  it("flags a nested packages/<pkg>/node_modules link into the install", () => {
    mkdirSync(join(sandbox, "packages", "ari"), { recursive: true });
    symlinkSync(installNm, join(sandbox, "packages", "ari", "node_modules"), "dir");
    expect(escapesSandbox(join(sandbox, "packages", "ari", "node_modules"), sandbox)).toBe(true);
  });

  it("does NOT flag a real isolated node_modules inside the sandbox", () => {
    mkdirSync(join(sandbox, "node_modules", "left-pad"), { recursive: true });
    expect(escapesSandbox(join(sandbox, "node_modules"), sandbox)).toBe(false);
  });

  it("does NOT flag a link that stays inside the sandbox", () => {
    mkdirSync(join(sandbox, "real-nm"), { recursive: true });
    symlinkSync(join(sandbox, "real-nm"), join(sandbox, "node_modules"), "dir");
    expect(escapesSandbox(join(sandbox, "node_modules"), sandbox)).toBe(false);
  });

  it("treats an absent node_modules as trivially isolated", () => {
    expect(escapesSandbox(join(sandbox, "node_modules"), sandbox)).toBe(false);
  });
});

describe("unlinkSharedJunctions — drops the link without traversing into the install", () => {
  let root: string, installNm: string, sandbox: string, marker: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-brick-"));
    installNm = join(root, "install", "node_modules");
    sandbox = join(root, "sandbox");
    marker = join(installNm, "sqlite-vec", "vec0.dll");
    mkdirSync(join(installNm, "sqlite-vec"), { recursive: true });
    writeFileSync(marker, "loaded-native-module");
    mkdirSync(sandbox, { recursive: true });
    symlinkSync(installNm, join(sandbox, "node_modules"), "dir");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports no stuck links and leaves the live install's native module intact", () => {
    const stuck = unlinkSharedJunctions(sandbox);
    expect(stuck).toEqual([]);
    expect(lstatSync(sandbox).isDirectory()).toBe(true);
    expect(existsSync(join(sandbox, "node_modules"))).toBe(false); // link gone
    expect(existsSync(marker)).toBe(true); // parent NOT traversed
  });

  it("a full sandbox wipe AFTER the drop cannot reach the install", () => {
    expect(unlinkSharedJunctions(sandbox)).toEqual([]);
    rmSync(sandbox, { recursive: true, force: true });
    expect(existsSync(marker)).toBe(true);
  });
});

describe("isDeferrableFileLock — defer vs revert decision", () => {
  it("classifies the reported EPERM-on-loaded-vec0.dll as deferrable", () => {
    const reported =
      "Command failed: npm ci\n" +
      "npm error code EPERM\n" +
      "npm error syscall unlink\n" +
      "npm error path C:\\Users\\peter\\AppData\\Local\\Local Agent X\\node_modules\\sqlite-vec-windows-x64\\vec0.dll\n" +
      "npm error errno -4048";
    expect(isDeferrableFileLock(reported)).toBe(true);
  });

  it("classifies EBUSY / resource-busy-or-locked as deferrable", () => {
    expect(isDeferrableFileLock("EBUSY: resource busy or locked, unlink 'skia.node'")).toBe(true);
    expect(isDeferrableFileLock("Error: EACCES: permission denied")).toBe(true);
  });

  it("does NOT defer a real dependency-resolution error (must revert)", () => {
    expect(isDeferrableFileLock("npm error code ERESOLVE\nnpm error could not resolve dependency")).toBe(false);
  });

  it("does NOT defer a registry 404 (must revert)", () => {
    expect(isDeferrableFileLock("npm error 404 Not Found - GET https://registry.npmjs.org/nope")).toBe(false);
  });
});

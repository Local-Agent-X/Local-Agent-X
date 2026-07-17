/**
 * Tests for writeSecretFileAtomic (R6-A3).
 *
 * The core property: a pre-planted symlink at the `<path>.tmp` location must
 * NOT redirect the write. All fixtures live under os.tmpdir() with synthetic
 * data — no real secrets, no keychain, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync,
  symlinkSync, statSync, lstatSync, writeSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { CAN_CREATE_FILE_SYMLINK } from "../symlink-capabilities.test-helper.js";
import { writeSecretFileAtomic, _writeSecretFileAtomicForTests } from "./secret-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-secretfile-"));
});

afterEach(() => {
  try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("writeSecretFileAtomic", () => {
  it("writes the file atomically with 0600 permissions", () => {
    const target = join(dir, "auth.json");
    writeSecretFileAtomic(target, '{"token":"synthetic"}');
    expect(readFileSync(target, "utf-8")).toBe('{"token":"synthetic"}');
    expect(existsSync(`${target}.tmp`)).toBe(false);
    if (platform() !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("refuses to write through a symlinked temp path (no redirect)", () => {
    const target = join(dir, "auth.json");
    const decoy = join(dir, "decoy.txt");
    writeFileSync(decoy, "original");
    // Attacker pre-stages auth.json.tmp -> decoy.txt so a naive write lands in decoy.
    symlinkSync(decoy, `${target}.tmp`);

    expect(() => writeSecretFileAtomic(target, '{"token":"synthetic"}')).toThrow();
    // The decoy was NOT overwritten, and the real target was never created.
    expect(readFileSync(decoy, "utf-8")).toBe("original");
    expect(existsSync(target)).toBe(false);
    // The planted symlink is left as-is (still a symlink, not followed).
    expect(lstatSync(`${target}.tmp`).isSymbolicLink()).toBe(true);
  });

  it("clears a stale regular temp file from a crashed write and succeeds", () => {
    const target = join(dir, "auth.json");
    writeFileSync(`${target}.tmp`, "leftover from a crash");
    writeSecretFileAtomic(target, '{"token":"fresh"}');
    expect(readFileSync(target, "utf-8")).toBe('{"token":"fresh"}');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("overwrites an existing target file", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, '{"token":"old"}');
    writeSecretFileAtomic(target, '{"token":"new"}');
    expect(readFileSync(target, "utf-8")).toBe('{"token":"new"}');
  });

  it("loops until every byte is written after short writes", () => {
    const target = join(dir, "auth.json");
    let calls = 0;
    _writeSecretFileAtomicForTests(target, "synthetic-secret", {
      write: ((fd, buffer, offset, length, position) => {
        calls += 1;
        const bytes = buffer as Buffer;
        const start = offset ?? 0;
        return writeSync(fd, bytes.subarray(start, start + Math.min(length ?? bytes.length, 3)));
      }) as typeof writeSync,
    });
    expect(calls).toBeGreaterThan(1);
    expect(readFileSync(target, "utf-8")).toBe("synthetic-secret");
  });

  it("preserves the valid target and cleans temp after a write failure", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, "valid-old-data");
    expect(() => _writeSecretFileAtomicForTests(target, "replacement", {
      write: (() => { throw new Error("synthetic write failure"); }) as typeof writeSync,
    })).toThrow(/synthetic write failure/);
    expect(readFileSync(target, "utf-8")).toBe("valid-old-data");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("preserves the valid target and cleans temp after fsync failure", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, "valid-old-data");
    expect(() => _writeSecretFileAtomicForTests(target, "replacement", {
      fsync: () => { throw new Error("synthetic fsync failure"); },
    })).toThrow(/synthetic fsync failure/);
    expect(readFileSync(target, "utf-8")).toBe("valid-old-data");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("preserves the valid target and cleans temp after close failure", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, "valid-old-data");
    expect(() => _writeSecretFileAtomicForTests(target, "replacement", {
      close: () => { throw new Error("synthetic close failure"); },
    })).toThrow(/synthetic close failure/);
    expect(readFileSync(target, "utf-8")).toBe("valid-old-data");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("preserves the valid target and cleans temp after rename failure", () => {
    const target = join(dir, "auth.json");
    writeFileSync(target, "valid-old-data");
    expect(() => _writeSecretFileAtomicForTests(target, "replacement", {
      rename: () => { throw new Error("synthetic rename failure"); },
    })).toThrow(/synthetic rename failure/);
    expect(readFileSync(target, "utf-8")).toBe("valid-old-data");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { ffmpegBin } from "./ffmpeg-bin.js";

const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

describe("ffmpegBin", () => {
  let savedFfmpeg: string | undefined;
  let savedBundled: string | undefined;

  beforeEach(() => {
    savedFfmpeg = process.env.LAX_FFMPEG;
    savedBundled = process.env.LAX_BUNDLED_BIN_DIR;
    delete process.env.LAX_FFMPEG;
    delete process.env.LAX_BUNDLED_BIN_DIR;
  });

  afterEach(() => {
    if (savedFfmpeg !== undefined) process.env.LAX_FFMPEG = savedFfmpeg;
    if (savedBundled !== undefined) process.env.LAX_BUNDLED_BIN_DIR = savedBundled;
  });

  it("LAX_FFMPEG override wins over everything", () => {
    process.env.LAX_FFMPEG = "/custom/ffmpeg";
    process.env.LAX_BUNDLED_BIN_DIR = "/some/bundle";
    expect(ffmpegBin()).toBe("/custom/ffmpeg");
  });

  it("uses the bundled copy when LAX_BUNDLED_BIN_DIR holds one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ffmpeg-"));
    try {
      writeFileSync(join(dir, exe), "");
      process.env.LAX_BUNDLED_BIN_DIR = dir;
      expect(ffmpegBin()).toBe(join(dir, exe));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a bundled dir that doesn't actually hold the binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ffmpeg-empty-"));
    try {
      process.env.LAX_BUNDLED_BIN_DIR = dir;
      expect(ffmpegBin()).not.toBe(join(dir, exe));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: consumers used to run a bare "ffmpeg", silently broken on a
  // fresh box with nothing on PATH. With ffmpeg-static installed the resolver
  // must hand back a real absolute path to a binary we ship.
  it("resolves an existing absolute binary from node_modules, not bare PATH", () => {
    const p = ffmpegBin();
    expect(isAbsolute(p)).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

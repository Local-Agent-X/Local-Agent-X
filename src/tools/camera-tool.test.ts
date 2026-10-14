// The capture drives ffmpeg's DirectShow input, which exists only on Windows.
// Off Windows it refuses with the reason before anything is spawned, instead
// of ffmpeg's opaque "Unknown input format: 'dshow'".
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-camera-"));

const spawned = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:child_process", () => ({
  execSync: () => { spawned.count++; return ""; },
  execFileSync: () => { spawned.count++; return Buffer.alloc(0); },
}));

const { captureFrame, listDevices } = await import("./camera-tool.js");

const REAL_PLATFORM = process.platform;
const setPlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, "platform", { value }); };
afterEach(() => { setPlatform(REAL_PLATFORM); spawned.count = 0; });

describe("camera capture off Windows", () => {
  it.each(["darwin", "linux"] as const)("%s: refuses with the reason, spawning nothing", (platform) => {
    setPlatform(platform);
    expect(() => captureFrame()).toThrow(new RegExp(`Windows-only.*DirectShow.*this machine is ${platform}`));
    expect(() => listDevices()).toThrow(/Windows-only/);
    expect(spawned.count).toBe(0);
  });
});

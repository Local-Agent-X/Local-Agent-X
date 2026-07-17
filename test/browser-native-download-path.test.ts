import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChromeExecutable } from "../src/browser/launcher.js";
import { getBrowserNativeDownloadDir, isInsideDirectory } from "../src/browser/download-paths.js";

const root = mkdtempSync(join(tmpdir(), "lax-native-download-live-"));
const chrome = findChromeExecutable();
const run = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "browser-native-download-repro.mjs");

type NativeProbe = { available: boolean; reason: string };

async function probeLiveCdp(quarantine: string, profile: string): Promise<NativeProbe> {
  if (!chrome) return { available: false, reason: "Chrome or Edge is not installed" };
  const { stdout } = await run(process.execPath, ["--import", "tsx", fixture, chrome, quarantine, profile, "--probe"], {
    cwd: process.cwd(),
    timeout: 15_000,
    windowsHide: true,
  });
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("NATIVE_PROBE="));
  if (!line) throw new Error(`live CDP probe returned no capability result: ${stdout}`);
  return JSON.parse(line.slice("NATIVE_PROBE=".length)) as NativeProbe;
}

async function runAfterCdpProbe<T>(
  capability: NativeProbe,
  skipUnavailable: (reason: string) => never,
  executeProductionFixture: () => Promise<T>,
): Promise<T> {
  if (!capability.available) skipUnavailable(`live Chrome/CDP startup unavailable: ${capability.reason}`);
  return executeProductionFixture();
}

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Chrome crashpad can release after the fixture exits */ }
});

describe("native browser download path", () => {
  it("does not reinterpret a production launch failure as a capability skip", async () => {
    let skipped = false;
    await expect(runAfterCdpProbe(
      { available: true, reason: "" },
      (reason) => { skipped = true; throw new Error(reason); },
      () => run(process.execPath, ["--definitely-invalid-production-browser-argument"]),
    )).rejects.toThrow(/bad option|unknown option/i);
    expect(skipped).toBe(false);
  });

  it("places the browser-created artifact in private quarantine before any handler inspects it", async ({ skip }) => {
    const quarantine = getBrowserNativeDownloadDir(root);
    const capability = await probeLiveCdp(quarantine, join(root, "probe-profile"));
    const realProfile = process.env.LOCALAPPDATA ? dirname(dirname(process.env.LOCALAPPDATA)) : process.env.USERPROFILE;
    const { stdout } = await runAfterCdpProbe(capability, (reason) => skip(reason), () => run(
      process.execPath,
      ["--import", "tsx", fixture, chrome!, quarantine, join(root, "profile")],
      {
        cwd: process.cwd(),
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, HOME: realProfile, USERPROFILE: realProfile },
      },
    ));
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("NATIVE_RESULT="));
    if (!line) throw new Error(`live CDP fixture returned no result: ${stdout}`);
    const result = JSON.parse(line.slice("NATIVE_RESULT=".length)) as { nativePath: string; existed: boolean; usedCdp: boolean; downloadSeen: boolean };
    expect(result.usedCdp).toBe(true);
    expect(result.downloadSeen).toBe(true);
    expect(result.existed).toBe(true);
    expect(isInsideDirectory(result.nativePath, quarantine)).toBe(true);
  }, 35_000);
});

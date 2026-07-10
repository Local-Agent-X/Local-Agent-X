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

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!chrome)("live native browser download path", () => {
  it("places the browser-created artifact in private quarantine before any handler inspects it", async () => {
    const quarantine = getBrowserNativeDownloadDir(root);
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "browser-native-download-repro.mjs");
    const realProfile = process.env.LOCALAPPDATA ? dirname(dirname(process.env.LOCALAPPDATA)) : process.env.USERPROFILE;
    const { stdout } = await run(process.execPath, [fixture, chrome!, quarantine, join(root, "profile")], {
      cwd: process.cwd(),
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, HOME: realProfile, USERPROFILE: realProfile },
    });
    const result = JSON.parse(stdout.trim()) as { nativePath: string; existed: boolean };
    expect(result.existed).toBe(true);
    expect(isInsideDirectory(result.nativePath, quarantine)).toBe(true);
  }, 35_000);
});

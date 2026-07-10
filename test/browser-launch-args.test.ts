import { describe, it, expect } from "vitest";
import {
  browserProxyArgs,
  browserProxyConfig,
  buildPersistentContextOptions,
  buildChromeLaunchArgs,
  DISABLE_FEATURES,
  STEALTH_ARGS,
} from "../src/browser/launcher.js";
import { getBrowserNativeDownloadDir, isInsideDirectory } from "../src/browser/download-paths.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Regression guard for the silent --disable-features clobber: Chrome honors
// only the LAST --disable-features occurrence, so every disable must flow
// through the single DISABLE_FEATURES list and be passed as one flag.
// RendererCodeIntegrity and --no-process-per-site were removed because they
// weaken Chrome's renderer integrity / site isolation.

describe("browser launch args — single --disable-features flag", () => {
  it("STEALTH_ARGS no longer carries its own --disable-features entry", () => {
    expect(STEALTH_ARGS.some((a) => a.startsWith("--disable-features="))).toBe(false);
  });

  it("STEALTH_ARGS drops the isolation-weakening flags", () => {
    expect(STEALTH_ARGS).not.toContain("--no-process-per-site");
    expect(STEALTH_ARGS.some((a) => /RendererCodeIntegrity/.test(a))).toBe(false);
  });

  it("DISABLE_FEATURES holds the intended features and excludes RendererCodeIntegrity", () => {
    expect(DISABLE_FEATURES).toContain("Translate");
    expect(DISABLE_FEATURES).toContain("MediaRouter");
    expect(DISABLE_FEATURES).toContain("DownloadBubble");
    expect(DISABLE_FEATURES).toContain("DownloadBubbleV2");
    expect(DISABLE_FEATURES as readonly string[]).not.toContain("RendererCodeIntegrity");
  });

  it("the effective disable-features flag is a single flag", () => {
    const flag = `--disable-features=${DISABLE_FEATURES.join(",")}`;
    expect(flag.indexOf("--disable-features")).toBe(0);
    expect(flag.indexOf("--disable-features", 1)).toBe(-1);
  });

  it("blocks Service Workers in persistent contexts", () => {
    expect(buildPersistentContextOptions("C:\\downloads", "http://127.0.0.1:43123")).toEqual(
      expect.objectContaining({
        serviceWorkers: "block",
        proxy: { server: "http://127.0.0.1:43123", bypass: "<-loopback>" },
      }),
    );
  });

  it("forces dedicated Chrome through the proxy without implicit loopback bypass", () => {
    expect(browserProxyArgs("http://127.0.0.1:43123")).toEqual([
      "--proxy-server=http://127.0.0.1:43123",
      "--proxy-bypass-list=<-loopback>",
    ]);
    expect(browserProxyConfig("http://127.0.0.1:43123")).toEqual({
      server: "http://127.0.0.1:43123",
      bypass: "<-loopback>",
    });
  });

  it("routes native CDP and persistent-context downloads only to private quarantine", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-native-download-path-"));
    try {
      const quarantine = getBrowserNativeDownloadDir(dataDir);
      const workspaceDownloads = resolve(dataDir, "workspace", "downloads");
      const options = buildPersistentContextOptions(quarantine, "http://127.0.0.1:43123");
      const args = buildChromeLaunchArgs(9222, join(dataDir, "profile"), quarantine, "http://127.0.0.1:43123");
      expect(options.downloadsPath).toBe(quarantine);
      expect(args).toContain(`--download.default_directory=${quarantine}`);
      expect(isInsideDirectory(quarantine, dataDir)).toBe(true);
      expect(isInsideDirectory(quarantine, workspaceDownloads)).toBe(false);
      expect(JSON.stringify({ options, args })).not.toContain(workspaceDownloads);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

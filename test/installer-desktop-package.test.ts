import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDesktopPackage, DESKTOP_FEED_ROOT } from "../scripts/installer/desktop-package.mjs";
import { findWindowsDesktop, windowsDesktopCandidates } from "../scripts/installer/windows-desktop-location.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function feed(platform: "darwin" | "win32", arch: "arm64" | "x64", bytes: Buffer) {
  const version = "0.5.3";
  const os = platform === "darwin" ? "mac" : "win";
  const ext = platform === "darwin" ? "zip" : "exe";
  const artifact = `Local-Agent-X-Desktop-${version}-${os}-${arch}.${ext}`;
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = `version: ${version}\nfiles:\n  - url: ${artifact}\n    sha512: ${sha512}\n`;
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith(".yml")) return new Response(metadata);
    return new Response(bytes);
  };
  return { artifact, calls, fetchImpl };
}

describe("migration desktop package resolver", () => {
  it.each([
    ["darwin", "arm64"],
    ["win32", "x64"],
  ] as const)("selects the exact %s/%s artifact and verifies its bytes", async (platform, arch) => {
    const root = mkdtempSync(join(tmpdir(), "lax-package-test-"));
    roots.push(root);
    const bytes = Buffer.from("signed-package");
    const fixture = feed(platform, arch, bytes);
    const acquired = await acquireDesktopPackage({
      platform, arch, fetchImpl: fixture.fetchImpl, temporaryRoot: root,
    });
    expect(fixture.calls).toEqual([
      `${DESKTOP_FEED_ROOT}/${platform === "darwin" ? "latest-mac.yml" : "latest.yml"}`,
      `${DESKTOP_FEED_ROOT}/${fixture.artifact}`,
    ]);
    expect(readFileSync(acquired.packagePath)).toEqual(bytes);
    acquired.cleanup();
    expect(existsSync(acquired.packagePath)).toBe(false);
  });

  it("fails closed and cleans up when the package hash differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-package-test-"));
    roots.push(root);
    const fixture = feed("win32", "x64", Buffer.from("expected"));
    const fetchImpl = async (url: string) => url.endsWith(".yml")
      ? fixture.fetchImpl(url)
      : new Response("tampered");
    await expect(acquireDesktopPackage({
      platform: "win32", arch: "x64", fetchImpl, temporaryRoot: root,
    })).rejects.toThrow("SHA-512");
  });

  it("rejects metadata that does not name the exact platform artifact", async () => {
    const sha512 = Buffer.alloc(64).toString("base64");
    const metadata = `version: 0.5.3\nfiles:\n  - url: https://evil.example/app.exe\n    sha512: ${sha512}\n`;
    const fetchImpl = async () => new Response(metadata);
    await expect(acquireDesktopPackage({
      platform: "win32", arch: "x64", fetchImpl,
    })).rejects.toThrow("expected Local-Agent-X-Desktop-0.5.3-win-x64.exe");
  });
});

describe("installer packaged-app seams", () => {
  it("does not build or launch a loose Electron runtime", () => {
    const windows = readFileSync(join(process.cwd(), "scripts/installer/windows-desktop.mjs"), "utf8");
    const mac = readFileSync(join(process.cwd(), "scripts/installer/mac-desktop.mjs"), "utf8");
    const viewModel = readFileSync(join(process.cwd(), "installer/ViewModels/MainWindowViewModel.cs"), "utf8");
    expect(windows).not.toContain("electron.exe");
    expect(windows).not.toContain("CreateShortcut");
    expect(mac).not.toContain('["run", "dist"]');
    expect(viewModel).not.toContain("loader.js");
    expect(viewModel).toContain('"local-agent-x-desktop", "LocalAgentX.exe"');
  });

  it("resolves electron-builder's one-click package-name directory before the legacy product-name directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-win-location-"));
    roots.push(root);
    const options = { env: {}, homeDirectory: root };
    const [current, legacy] = windowsDesktopCandidates(options);
    expect(current).toBe(join(root, "AppData", "Local", "Programs", "local-agent-x-desktop", "LocalAgentX.exe"));
    expect(legacy).toBe(join(root, "AppData", "Local", "Programs", "Local Agent X", "LocalAgentX.exe"));
    expect(findWindowsDesktop(options)).toBeNull();
    mkdirSync(join(current, ".."), { recursive: true });
    writeFileSync(current, "signed-app");
    expect(findWindowsDesktop(options)).toBe(current);
  });

  it("requires Windows Authenticode and macOS codesign verification", () => {
    const windows = readFileSync(join(process.cwd(), "scripts/installer/windows-desktop.mjs"), "utf8");
    const mac = readFileSync(join(process.cwd(), "scripts/installer/mac-desktop.mjs"), "utf8");
    expect(windows).toContain("Get-AuthenticodeSignature");
    expect(windows).toContain("Status -ne 'Valid'");
    expect(mac).toContain('"--verify", "--deep", "--strict"');
    expect(mac).not.toContain("codesign --sign");
  });

  it("clears only macOS provenance before verifying extracted and installed apps", () => {
    const mac = readFileSync(join(process.cwd(), "scripts/installer/mac-desktop.mjs"), "utf8");
    expect(mac.match(/\["-dr", "com\.apple\.provenance",/g)).toHaveLength(2);
    expect(mac).not.toContain('xattr", ["-cr"');
  });

  it("does not ship restricted macOS entitlements without a provisioning profile", () => {
    const entitlements = readFileSync(join(process.cwd(), "desktop/build/entitlements.mac.plist"), "utf8");
    expect(entitlements).not.toContain("com.apple.developer.speech-recognition");
  });
});

// A friend's install died on "Desktop app download failed: fetch failed", the
// bare message Node gives for any dropped connection, with the cause (DNS,
// reset, timeout, certificate) thrown away.
describe("installer downloads survive a dropped connection and name the cause", () => {
  const dropped = () => new TypeError("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", host: "release-assets.githubusercontent.com" }),
  });

  it("retries a dropped connection and completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lax-package-test-"));
    roots.push(root);
    const fixture = feed("win32", "x64", Buffer.from("signed-package"));
    let drops = 2;
    const acquired = await acquireDesktopPackage({
      platform: "win32", arch: "x64", temporaryRoot: root, retryDelayMs: 0,
      fetchImpl: async (url: string) => { if (drops-- > 0) throw dropped(); return fixture.fetchImpl(url); },
    });
    expect(readFileSync(acquired.packagePath, "utf-8")).toBe("signed-package");
    acquired.cleanup();
  });

  it("reports the underlying cause and host when it keeps failing", async () => {
    await expect(acquireDesktopPackage({
      platform: "win32", arch: "x64", retryDelayMs: 0, fetchImpl: async () => { throw dropped(); },
    })).rejects.toThrow(/could not reach github\.com after 3 tries: fetch failed \(ECONNRESET release-assets\.githubusercontent\.com: read ECONNRESET\)/);
  });

  it("does not retry an HTTP error; that is an answer", async () => {
    let calls = 0;
    await expect(acquireDesktopPackage({
      platform: "win32", arch: "x64", retryDelayMs: 0, fetchImpl: async () => { calls += 1; return new Response("nope", { status: 404 }); },
    })).rejects.toThrow(/\(404\)/);
    expect(calls).toBe(1);
  });
});

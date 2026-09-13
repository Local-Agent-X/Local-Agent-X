/**
 * ONE reusable Android SDK installer. Both the CLI entry point
 * (scripts/install-android-sdk.ts) and the in-app "Set up Android SDK"
 * button (src/routes/settings/android.ts) call installAndroidSdk() — neither
 * duplicates this logic.
 *
 * Steps: download+extract cmdline-tools (if missing) -> accept licenses ->
 * sdkmanager install platform-tools/emulator/a system image -> avdmanager
 * create a default AVD (if none exists yet).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidSdkRoot, avdmanagerBin, checkAndroidSdk, cmdlineToolsRoot, sdkmanagerBin } from "./sdk-paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("android.sdk-installer");

// Google does not publish a stable "latest" URL for cmdline-tools — each
// release is a versioned build number. Bump this when Google ships a newer
// one; the installer still works against an older build, it just misses
// whatever sdkmanager fixes shipped since.
const CMDLINE_TOOLS_BUILD = "11076708";
const DEFAULT_SYSTEM_IMAGE = "system-images;android-34;google_apis;x86_64";
const DEFAULT_AVD_NAME = "lax_default";

function cmdlineToolsUrl(): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  return `https://dl.google.com/android/repository/commandlinetools-${platform}-${CMDLINE_TOOLS_BUILD}_latest.zip`;
}

export type InstallProgress = (step: string) => void;

async function download(url: string, destFile: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destFile, buf);
}

/** No zip-extraction dependency in package.json — shell out to the platform's
 *  own extractor (Expand-Archive on Windows, unzip elsewhere) instead of
 *  adding one for this single call site. */
function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, args] = process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`]]
      : ["unzip", ["-o", "-q", zipPath, "-d", destDir]];
    const proc = spawn(bin, args, { stdio: "ignore" });
    proc.on("error", (e) => reject(new Error(`extract failed: ${e.message}`)));
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`extract exited with code ${code}`)));
  });
}

function runTool(bin: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: [stdin ? "pipe" : "ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (e) => reject(new Error(`${bin} spawn error: ${e.message}`)));
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 500)}`)));
    if (stdin) { proc.stdin!.write(stdin); proc.stdin!.end(); }
  });
}

async function installCmdlineTools(onProgress: InstallProgress): Promise<void> {
  onProgress("Downloading Android command-line tools...");
  const tmp = await mkdtemp(join(tmpdir(), "lax-android-sdk-"));
  const zipPath = join(tmp, "cmdline-tools.zip");
  try {
    await download(cmdlineToolsUrl(), zipPath);
    onProgress("Extracting command-line tools...");
    const extractDir = join(tmp, "extracted");
    await mkdir(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);
    // The zip's top-level entry is "cmdline-tools/" itself; sdkmanager only
    // recognizes it once that's renamed to a version dir (conventionally "latest").
    const extractedToolsDir = join(extractDir, "cmdline-tools");
    const finalDir = join(cmdlineToolsRoot(), "latest");
    await mkdir(cmdlineToolsRoot(), { recursive: true });
    await rm(finalDir, { recursive: true, force: true });
    await rename(extractedToolsDir, finalDir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function acceptLicenses(onProgress: InstallProgress): Promise<void> {
  onProgress("Accepting SDK licenses...");
  // sdkmanager --licenses prompts once per unaccepted license; a long run of
  // "y\n" answers every prompt regardless of how many there are this release.
  await runTool(sdkmanagerBin(), ["--licenses"], "y\n".repeat(20));
}

async function installPackages(onProgress: InstallProgress): Promise<void> {
  onProgress("Installing platform-tools, emulator, and a system image (this can take several minutes)...");
  await runTool(sdkmanagerBin(), ["platform-tools", "emulator", DEFAULT_SYSTEM_IMAGE]);
}

async function createDefaultAvd(onProgress: InstallProgress): Promise<void> {
  onProgress(`Creating default AVD "${DEFAULT_AVD_NAME}"...`);
  // avdmanager asks "Do you wish to create a custom hardware profile [no]" —
  // answer no and take the system image's stock profile.
  await runTool(avdmanagerBin(), ["create", "avd", "--force", "-n", DEFAULT_AVD_NAME, "-k", DEFAULT_SYSTEM_IMAGE], "no\n");
}

export async function installAndroidSdk(onProgress: InstallProgress = () => {}): Promise<void> {
  await mkdir(androidSdkRoot(), { recursive: true });
  const status = checkAndroidSdk();
  if (!status.hasCmdlineTools) await installCmdlineTools(onProgress);
  await acceptLicenses(onProgress);
  await installPackages(onProgress);
  // No reliable "AVD already exists" probe across SDK versions — just ask
  // avdmanager and treat a failure (e.g. already exists) as non-fatal.
  try { await createDefaultAvd(onProgress); } catch (e) {
    log.warn(`AVD creation skipped/failed (may already exist): ${(e as Error).message}`);
  }
  onProgress("Android SDK setup complete.");
}

export function getSdkStatus() {
  return checkAndroidSdk();
}

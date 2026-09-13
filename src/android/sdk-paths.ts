/**
 * Android SDK location + binary resolution — the single chokepoint every
 * consumer (adb bridge, emulator process manager, sdk-installer) resolves
 * through, mirroring ffmpeg-bin.ts's ANDROID_HOME-then-conventional-path order.
 *
 * Order:
 *   1. ANDROID_HOME / ANDROID_SDK_ROOT — explicit operator/CI convention, always wins;
 *   2. the platform's default install location (what `sdkmanager`/Android Studio
 *      itself writes to on a fresh machine).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const winExt = process.platform === "win32" ? ".exe" : "";
const batExt = process.platform === "win32" ? ".bat" : "";

function platformDefaultRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Android", "Sdk");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Android", "sdk");
  }
  return join(homedir(), "Android", "Sdk");
}

export function androidSdkRoot(): string {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || platformDefaultRoot();
}

export function adbBin(): string {
  return join(androidSdkRoot(), "platform-tools", "adb" + winExt);
}

export function emulatorBin(): string {
  return join(androidSdkRoot(), "emulator", "emulator" + winExt);
}

// cmdline-tools installs under a version-named directory ("latest" is the
// conventional symlink/copy `sdkmanager --install "cmdline-tools;latest"`
// creates); sdk-installer.ts is the one place that lays it down.
export function sdkmanagerBin(): string {
  return join(androidSdkRoot(), "cmdline-tools", "latest", "bin", "sdkmanager" + batExt);
}

export function avdmanagerBin(): string {
  return join(androidSdkRoot(), "cmdline-tools", "latest", "bin", "avdmanager" + batExt);
}

export function cmdlineToolsRoot(): string {
  return join(androidSdkRoot(), "cmdline-tools");
}

export interface AndroidSdkAvailability {
  sdkRoot: string;
  hasAdb: boolean;
  hasEmulator: boolean;
  hasCmdlineTools: boolean;
  hasSdkmanager: boolean;
  hasAvdmanager: boolean;
  /** True once adb + emulator + the cmdline tools needed to manage AVDs are all present. */
  ready: boolean;
}

export function checkAndroidSdk(): AndroidSdkAvailability {
  const hasAdb = existsSync(adbBin());
  const hasEmulator = existsSync(emulatorBin());
  const hasSdkmanager = existsSync(sdkmanagerBin());
  const hasAvdmanager = existsSync(avdmanagerBin());
  return {
    sdkRoot: androidSdkRoot(),
    hasAdb,
    hasEmulator,
    hasCmdlineTools: hasSdkmanager && hasAvdmanager,
    hasSdkmanager,
    hasAvdmanager,
    ready: hasAdb && hasEmulator,
  };
}

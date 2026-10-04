/**
 * Pre-dispatch gate: every action but `list_devices` needs adb (and
 * start_emulator needs the emulator binary too) — fail with actionable
 * guidance instead of a raw "spawn ENOENT" from deep inside adb.ts.
 */

import type { ToolResult } from "../../types.js";
import { checkAndroidSdk } from "../../android/index.js";
import { blocked } from "../result-helpers.js";

const SETUP_RECOVERY =
  "Tell the user the Android SDK isn't installed: the \"Set up Android SDK\" button in Settings (or `npm run android:install-sdk`) installs it. " +
  "Continue with any part of the request that doesn't need the device.";

export function sdkReadinessGate(action: string): ToolResult | null {
  const status = checkAndroidSdk();
  if (!status.hasAdb) {
    return blocked(`BLOCKED: Android SDK not found at "${status.sdkRoot}" (adb missing).`, { layer: "android-sdk", androidStatus: "sdk-missing", recovery: SETUP_RECOVERY });
  }
  if (action === "start_emulator" && !status.hasEmulator) {
    return blocked(`BLOCKED: Android emulator binary not found at "${status.sdkRoot}".`, { layer: "android-sdk", androidStatus: "sdk-missing", recovery: SETUP_RECOVERY });
  }
  return null;
}

/**
 * Pre-dispatch gate: every action but `list_devices` needs adb (and
 * start_emulator needs the emulator binary too) — fail with actionable
 * guidance instead of a raw "spawn ENOENT" from deep inside adb.ts.
 */

import type { ToolResult } from "../../types.js";
import { checkAndroidSdk } from "../../android/index.js";
import { blocked } from "../result-helpers.js";

const SETUP_HINT = "Run the \"Set up Android SDK\" button in Settings (or `npm run android:install-sdk`) to install it.";

export function sdkReadinessGate(action: string): ToolResult | null {
  const status = checkAndroidSdk();
  if (!status.hasAdb) {
    return blocked(`BLOCKED: Android SDK not found at "${status.sdkRoot}" (adb missing). ${SETUP_HINT}`, { layer: "android-sdk", androidStatus: "sdk-missing" });
  }
  if (action === "start_emulator" && !status.hasEmulator) {
    return blocked(`BLOCKED: Android emulator binary not found at "${status.sdkRoot}". ${SETUP_HINT}`, { layer: "android-sdk", androidStatus: "sdk-missing" });
  }
  return null;
}

/**
 * Pre-dispatch gate: every action but `list_devices` needs adb (and
 * start_emulator needs the emulator binary too) — fail with actionable
 * guidance instead of a raw "spawn ENOENT" from deep inside adb.ts.
 */

import type { ToolResult } from "../../types.js";
import { checkAndroidSdk, holdDevice, resolveSerial, watchDevice, HOLD_IDLE_MS } from "../../android/index.js";
import { getSessionOwner } from "../../browser/session-owner-registry.js";
import { sessionIdOf } from "../../tool-execution/internal-args.js";
import { blocked, err } from "../result-helpers.js";
import { DEVICE_DRIVING_ACTIONS } from "./action-tables.js";

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

/**
 * One chat drives a device at a time (android/device-hold.ts). A driving
 * action by another chat's agent comes back as an error naming the wait, not
 * a refusal: the same call works once the device is free. The chat is the one
 * the run belongs to, so a build's worker drives for the chat that started it.
 * A call with no session, or with no one device to name, is left to its
 * handler, which says what is wrong.
 */
export async function deviceHoldGate(action: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  if (!DEVICE_DRIVING_ACTIONS.has(action)) return null;
  const sessionId = sessionIdOf(args);
  if (!sessionId) return null;
  let serial: string;
  try {
    serial = await resolveSerial(args.device ? String(args.device) : undefined);
  } catch {
    return null; // no device, or several and none named: the handler reports it
  }
  const chat = getSessionOwner(sessionId)?.browserSessionId ?? sessionId;
  const heldBy = holdDevice(serial, chat);
  if (!heldBy) {
    // The device the agent is driving is the one the app's Android tab shows,
    // whoever booted it (android/frame-stream.ts).
    watchDevice(serial);
    return null;
  }
  return err(
    `Android device ${serial} is in use by another chat. It frees up ${Math.round(HOLD_IDLE_MS / 60_000)} minutes after that chat last used it. ` +
    "Do not start another emulator to get around this: this app tracks and shows one. Do the parts of the task that need no device, then try again, or tell the user the device is busy.",
    { androidStatus: "device-held", heldBy },
  );
}

/**
 * Android tool — aggregator + dispatcher. One tool (`android`) with an
 * `action` discriminator, mirroring src/tools/browser-tools/index.ts. Per-
 * action handlers live alongside this file:
 *   description.ts   — static tool name + description + parameters schema
 *   action-tables.ts — read-only action classification (drives `effect`)
 *   gates.ts          — SDK-readiness pre-dispatch gate
 *   devices.ts        — list_devices, start_emulator, stop_emulator
 *   interact.ts       — tap, swipe, type_text, key_event
 *   apps.ts           — install_apk, launch_app, list_apps
 *   capture.ts        — screenshot
 */

import type { ToolDefinition } from "../../types.js";
import {
  ANDROID_TOOL_NAME,
  ANDROID_TOOL_DESCRIPTION,
  ANDROID_TOOL_COMPACT_DESCRIPTION,
  ANDROID_TOOL_PARAMETERS,
} from "./description.js";
import { READ_ONLY_ACTIONS } from "./action-tables.js";
import { sdkReadinessGate } from "./gates.js";
import { handleListDevices, handleStartEmulator, handleStopEmulator } from "./devices.js";
import { handleTap, handleSwipe, handleTypeText, handleKeyEvent } from "./interact.js";
import { handleInstallApk, handleLaunchApp, handleListApps } from "./apps.js";
import { handleScreenshot } from "./capture.js";
import { err } from "../result-helpers.js";

export function createAndroidTools(): ToolDefinition[] {
  const androidTool: ToolDefinition = {
    name: ANDROID_TOOL_NAME,
    effect: (args) => READ_ONLY_ACTIONS.has(String(args.action || ""))
      ? { class: "read-only" }
      : { class: "non-idempotent" },
    description: ANDROID_TOOL_DESCRIPTION,
    compactDescription: ANDROID_TOOL_COMPACT_DESCRIPTION,
    parameters: ANDROID_TOOL_PARAMETERS,
    async execute(args) {
      const action = String(args.action || "");
      try {
        const gated = sdkReadinessGate(action);
        if (gated) return gated;
        switch (action) {
          case "list_devices": return await handleListDevices();
          case "start_emulator": return await handleStartEmulator(args);
          case "stop_emulator": return await handleStopEmulator(args);
          case "screenshot": return await handleScreenshot(args);
          case "tap": return await handleTap(args);
          case "swipe": return await handleSwipe(args);
          case "type_text": return await handleTypeText(args);
          case "key_event": return await handleKeyEvent(args);
          case "install_apk": return await handleInstallApk(args);
          case "launch_app": return await handleLaunchApp(args);
          case "list_apps": return await handleListApps(args);
          default:
            return err(`Unknown action: "${action}". Valid actions: list_devices, start_emulator, stop_emulator, screenshot, tap, swipe, type_text, key_event, install_apk, launch_app, list_apps`);
        }
      } catch (e) {
        return err(`Android error: ${(e as Error).message}`);
      }
    },
  };

  return [androidTool];
}

// Server-side helpers for the computer-control kill-switch. NO nut.js here —
// this only flips the enableComputerControl config flag that pre-dispatch.ts
// reads. Actuation lives in tools/input-driver.ts.

import { getRuntimeConfig, saveConfig } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import { createLogger } from "./logger.js";

const logger = createLogger("computer-control");

/**
 * Flip the enableComputerControl kill-switch OFF, mirroring the `setting`
 * tool's runtime-apply (mutate the live config object in place so the next
 * pre-dispatch read sees it, persist to config.json, mirror to settings.json).
 *
 * Called by the panic hotkey so a stop both aborts the current run AND prevents
 * the next turn from driving the mouse/keyboard. Re-arming is a deliberate user
 * action (the Settings toggle), never automatic.
 */
export function disarmComputerControl(): void {
  const cfg = getRuntimeConfig();
  (cfg as unknown as Record<string, unknown>).enableComputerControl = false;
  saveConfig(cfg);
  saveSettings({ ...loadSettings(), enableComputerControl: false });
  logger.warn("[computer-control] disarmed (enableComputerControl=false)");
}

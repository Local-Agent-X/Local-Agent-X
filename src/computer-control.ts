// Server-side helpers for the computer-control kill-switch. NO nut.js here —
// this only flips the enableComputerControl config flag that pre-dispatch.ts
// reads. Actuation lives in tools/input-driver.ts.

import { getRuntimeConfig, saveConfig } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import { createLogger } from "./logger.js";

const logger = createLogger("computer-control");

/**
 * Flip BOTH input kill-switches OFF — the agent's (enableComputerControl) and a
 * paired phone's (enableRemoteControl) — mirroring the `setting` tool's runtime-
 * apply (mutate the live config object in place so the next read sees it, persist
 * to config.json, mirror to settings.json).
 *
 * Called by the panic hotkey so a stop both aborts the current run AND stops both
 * the agent's next turn and the phone's live session from driving the mouse/
 * keyboard. Re-arming is a deliberate user action (the Settings toggles), never
 * automatic.
 */
export function disarmComputerControl(): void {
  const cfg = getRuntimeConfig();
  (cfg as unknown as Record<string, unknown>).enableComputerControl = false;
  (cfg as unknown as Record<string, unknown>).enableRemoteControl = false;
  saveConfig(cfg);
  saveSettings({ ...loadSettings(), enableComputerControl: false, enableRemoteControl: false });
  logger.warn("[computer-control] disarmed (enableComputerControl=false, enableRemoteControl=false)");
}

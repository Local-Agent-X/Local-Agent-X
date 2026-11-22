// Server-side helpers for the computer-control kill-switch. NO nut.js here —
// this only flips the enableComputerControl config flag that pre-dispatch.ts
// reads. Actuation lives in tools/input-driver.ts.

import { createLogger } from "./logger.js";
import { applySettings } from "./settings-apply.js";

const logger = createLogger("computer-control");

/**
 * Flip BOTH input kill-switches OFF — the agent's (enableComputerControl) and a
 * paired phone's (enableRemoteControl) — through the one settings path
 * (settings-apply.ts): the running config holds both off before this returns,
 * then config.json and settings.json are saved and every open tab is told about
 * both, so none keeps showing either switch on.
 *
 * Called by the panic hotkey so a stop both aborts the current run AND stops both
 * the agent's next turn and the phone's live session from driving the mouse/
 * keyboard. Re-arming is a deliberate user action (the Settings toggles), never
 * automatic.
 */
export async function disarmComputerControl(): Promise<void> {
  await applySettings({ enableComputerControl: false, enableRemoteControl: false });
  logger.warn("[computer-control] disarmed (enableComputerControl=false, enableRemoteControl=false)");
}

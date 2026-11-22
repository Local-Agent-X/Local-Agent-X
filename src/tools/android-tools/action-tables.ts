/**
 * Android action classification — the single source of truth for which
 * `android` actions are read-only (drives the tool's `effect` class and the
 * kernel action derivation). Mirrors browser-tools/action-tables.ts, minus
 * the browser-specific stall/human-verification machinery this tool has no
 * equivalent of (no page-fingerprint concept, no CAPTCHA interstitials).
 */

export interface ActionTable {
  has(action: string): boolean;
}

function sealedTable(values: Iterable<string>): ActionTable {
  const set = new Set(values);
  return Object.freeze({ has: (action: string): boolean => set.has(action) });
}

export const READ_ONLY_ACTIONS = sealedTable(["list_devices", "screenshot", "list_apps"]);

/** The actions that change what is on a device's screen or what is installed
 *  on it: the ones one chat at a time may make (android/device-hold.ts).
 *  start_emulator is not one: the device it would drive does not exist yet. */
export const DEVICE_DRIVING_ACTIONS = sealedTable([
  "tap", "swipe", "type_text", "key_event", "install_apk", "launch_app", "port_forward", "open_url", "stop_emulator",
]);

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

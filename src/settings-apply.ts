/**
 * The one way the server changes user settings (fields in FLIPPABLE_SETTINGS,
 * settings-schema.ts). The Settings page (routes/settings/preferences.ts), the
 * agent's `setting` tool and the panic hotkey's disarm (computer-control.ts)
 * all go through it, so each change gets every step:
 *
 *   1. settings.json — the UI's copy, written for every field;
 *   2. the running config and config.json — for runtime fields that validate,
 *      so the next tool call sees the new value;
 *   3. what a changed runtime field must do at once (a new browser mode closes
 *      the open browsers; turning on local-only mode tears down remote work);
 *   4. a `settings_changed` frame to every open tab for the fields that
 *      broadcast, so no tab keeps showing the old value.
 *
 * Each caller kept its own copy of these steps, and one (the disarm) had
 * dropped the broadcast for one of its two fields. Who may change a field, and
 * whether a widening change needs the user's yes, is decided before this is
 * called, by the caller.
 */
import { getRuntimeConfig, saveConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { BROADCAST_KEYS, settingSpec } from "./settings-schema.js";
import { loadSettings, saveSettings } from "./settings.js";

const logger = createLogger("settings-apply");

export interface AppliedSettings {
  /** The fields whose value passed the schema, as parsed. */
  valid: Record<string, unknown>;
  /** Runtime fields whose live value changed. */
  runtimeChanged: string[];
  /** How many open tabs received the change; 0 when no field broadcasts. */
  broadcastTo: number;
}

/**
 * Apply `updates` (field → value). A value that fails its schema is kept in
 * settings.json, as the Settings page always did, but never reaches the running
 * config. Steps 1 and 2 complete before the first await, so the running config
 * holds the new values as soon as this is called.
 */
export async function applySettings(updates: Record<string, unknown>): Promise<AppliedSettings> {
  const valid: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(updates)) {
    const parsed = settingSpec(field)?.validate.safeParse(value);
    if (parsed?.success) valid[field] = parsed.data;
  }
  saveSettings({ ...loadSettings(), ...updates, ...valid });

  const runtimeConfig = getRuntimeConfig();
  const live = runtimeConfig as unknown as Record<string, unknown>;
  const runtimeChanged: string[] = [];
  let runtimeTouched = false;
  for (const [field, value] of Object.entries(valid)) {
    if (!settingSpec(field)?.runtime) continue;
    runtimeTouched = true;
    if (live[field] !== value) runtimeChanged.push(field);
    live[field] = value;
  }
  if (runtimeTouched) saveConfig(runtimeConfig);

  await applyChangedRuntimeEffects(runtimeChanged, valid);
  return { valid, runtimeChanged, broadcastTo: await broadcastChanged(valid) };
}

async function applyChangedRuntimeEffects(changed: string[], valid: Record<string, unknown>): Promise<void> {
  if (changed.includes("browserMode")) {
    const { closeAllBrowsers } = await import("./browser/index.js");
    await closeAllBrowsers();
  }
  if (changed.includes("localOnlyMode") && valid.localOnlyMode === true) {
    const { activateLocalOnlyMode } = await import("./local-only-policy.js");
    await activateLocalOnlyMode();
  }
}

async function broadcastChanged(valid: Record<string, unknown>): Promise<number> {
  const settings = Object.fromEntries(Object.entries(valid).filter(([field]) => BROADCAST_KEYS.has(field)));
  if (Object.keys(settings).length === 0) return 0;
  try {
    const { broadcastAll } = await import("./chat-ws/index.js");
    return broadcastAll({ type: "settings_changed", settings });
  } catch (e) {
    logger.warn(`[settings] settings_changed broadcast failed: ${(e as Error).message}`);
    return 0;
  }
}

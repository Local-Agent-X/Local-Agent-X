// Bridge feature flag + bind configuration.
//
// The bridge is OPT-IN and OFF by default. When off, the server's behavior is
// EXACTLY today's loopback-only posture — no extra bind, no device tokens
// honored. This is load-bearing: existing single-machine users must see zero
// change.
//
// Two ways to enable:
//   1. UI toggle — persists `bridge.enabled: true` in the canonical settings
//      store (~/.lax/settings.json via src/settings.ts). This is the path a
//      regular user takes (Settings → Mobile). Takes effect on next restart
//      because the tailnet bind happens at server startup.
//   2. LAX_BRIDGE_ENABLED=1 (or "true") — an env OVERRIDE for headless/dev/CI
//      where there's no UI. Either source enabling it turns the bridge on.
//
// Optional bind-address override: LAX_BRIDGE_BIND_ADDR (used only when no
// Tailscale CGNAT address is detected).
//
// `isBridgeEnabled()` is hit on every WS upgrade, so it must be cheap: the
// persisted value is loaded into memory ONCE at startup (it only changes across
// restarts) — we never read settings.json on the hot path.

import { getSetting } from "../settings.js";

export interface BridgeConfig {
  enabled: boolean;
  /** Explicit bind-addr override; tailnet auto-detection takes precedence. */
  bindAddrOverride?: string;
}

/** Persisted-flag key in the canonical settings store. */
export const BRIDGE_ENABLED_SETTING = "bridge.enabled";

function envTrue(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

// In-memory snapshot of the persisted `bridge.enabled` flag. Loaded once at
// startup via loadPersistedBridgeEnabled() so the hot-path isBridgeEnabled()
// never touches disk. `null` means "not loaded yet" — fall back to reading the
// settings cache lazily so a unit test that flips the setting still sees it.
let _persistedEnabled: boolean | null = null;

/**
 * Read the persisted `bridge.enabled` flag from the canonical settings store
 * into memory. Call once at startup (before the bind decision). Idempotent;
 * returns the loaded value. The persisted flag only changes across restarts, so
 * this snapshot is authoritative for the process lifetime.
 */
export function loadPersistedBridgeEnabled(): boolean {
  _persistedEnabled = getSetting<boolean>(BRIDGE_ENABLED_SETTING) === true;
  return _persistedEnabled;
}

/** Test seam — reset the in-memory snapshot so the next read re-derives it. */
export function resetPersistedBridgeEnabledForTest(): void {
  _persistedEnabled = null;
}

/** Read the bridge config (env override OR persisted flag). Default: disabled. */
export function loadBridgeConfig(): BridgeConfig {
  return {
    enabled: isBridgeEnabled(),
    bindAddrOverride: process.env.LAX_BRIDGE_BIND_ADDR?.trim() || undefined,
  };
}

/**
 * Is the bridge enabled this process? True if EITHER the env override is set OR
 * the persisted setting is true. Cheap: env read + an in-memory boolean. The
 * persisted snapshot is populated at startup; if a caller hits this before
 * startup loaded it (e.g. a unit test), we lazily read the settings cache —
 * still no disk read on the steady-state hot path.
 */
export function isBridgeEnabled(): boolean {
  if (envTrue(process.env.LAX_BRIDGE_ENABLED)) return true;
  if (_persistedEnabled === null) return loadPersistedBridgeEnabled();
  return _persistedEnabled;
}

/** Whether the LAX_BRIDGE_UI reveal flag is set (for testing/preview). */
export function isBridgeUiEnvFlag(): boolean {
  return envTrue(process.env.LAX_BRIDGE_UI);
}

/**
 * Pure gate for whether the desktop Settings → Mobile tab is shown. The mobile
 * bridge is an UNRELEASED feature, so the tab is HIDDEN from regular users and
 * revealed only when LAX_BRIDGE_UI is set (testing/preview) OR the bridge has
 * already been enabled/persisted (so an enabled user can still manage it).
 * Default — all false — keeps it hidden.
 */
export function resolveBridgeUiVisible(envUi: boolean, enabled: boolean, persisted: boolean): boolean {
  return envUi || enabled || persisted;
}

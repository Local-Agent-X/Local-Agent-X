// Bridge feature flag + bind configuration.
//
// The bridge is OPT-IN and OFF by default. When off, the server's behavior is
// EXACTLY today's loopback-only posture — no extra bind, no device tokens
// honored. This is load-bearing: existing single-machine users must see zero
// change.
//
// Enable with LAX_BRIDGE_ENABLED=1 (or "true"). Optional bind-address override:
// LAX_BRIDGE_BIND_ADDR (used only when no Tailscale CGNAT address is detected).

export interface BridgeConfig {
  enabled: boolean;
  /** Explicit bind-addr override; tailnet auto-detection takes precedence. */
  bindAddrOverride?: string;
}

function envTrue(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/** Read the bridge config from the environment. Default: disabled. */
export function loadBridgeConfig(): BridgeConfig {
  return {
    enabled: envTrue(process.env.LAX_BRIDGE_ENABLED),
    bindAddrOverride: process.env.LAX_BRIDGE_BIND_ADDR?.trim() || undefined,
  };
}

/** Convenience: is the bridge enabled this process? Read live each call so a
 *  test can flip LAX_BRIDGE_ENABLED without re-importing. */
export function isBridgeEnabled(): boolean {
  return envTrue(process.env.LAX_BRIDGE_ENABLED);
}

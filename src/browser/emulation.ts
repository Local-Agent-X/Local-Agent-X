/**
 * Device emulation profiles — the per-session viewport / device-metrics / UA
 * overrides the `browser` tool's `emulate` action installs.
 *
 * WHY THIS EXISTS: a site can serve phones a DIFFERENT HTML document. Without
 * a mobile viewport AND a mobile user agent the agent measures the desktop
 * rendering and reports it clean — about the wrong page. That failure cost one
 * session ~110 turns on a mobile-only layout defect it could not reproduce.
 *
 * WHY IT IS A CONTEXT OPTION, NOT A CDP CALL: `userAgent`, `isMobile`,
 * `hasTouch` and `deviceScaleFactor` are Playwright CONTEXT-CREATION options —
 * they cannot be mutated on a live context. The raw-CDP alternative
 * (the CDP Emulation domain's setDeviceMetricsOverride / setUserAgentOverride)
 * is rejected on purpose: it would have to be sent through the session's live page, which on
 * the in-app backend is the browser the USER is looking at, and attaching a
 * debugger to drive it re-triggers the Cloudflare Turnstile detection fixed at
 * bad9c360. So emulation is expressed as a profile here and applied by
 * runtime.acquireSessionContext when it mints a fresh QUARANTINED context.
 *
 * The profile is keyed by the RESOLVED browser session id (the same ownerId
 * BrowserManager passes to the runtime), never by raw request session id.
 */

export interface EmulationProfile {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string;
}

/** Named devices so the agent never has to invent a plausible mobile UA — an
 *  invented one is exactly how UA-conditional serving gets mis-diagnosed. */
export const EMULATION_PRESETS: Readonly<Record<string, EmulationProfile>> = Object.freeze({
  iphone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  android: {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/126.0.0.0 Mobile Safari/537.36",
  },
  ipad: {
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
});

/** Resolved-session-id → profile. Absent means "no emulation": the session's
 *  context is minted from the unmodified defaults, exactly as before. */
const sessionEmulation = new Map<string, EmulationProfile>();

export function setSessionEmulation(ownerId: string, profile: EmulationProfile | null): void {
  if (profile) sessionEmulation.set(ownerId, profile);
  else sessionEmulation.delete(ownerId);
}

export function getSessionEmulation(ownerId: string): EmulationProfile | undefined {
  return sessionEmulation.get(ownerId);
}

/** Session teardown clears the override — a reused session id must never
 *  inherit a previous session's phone viewport. */
export function clearSessionEmulation(ownerId: string): void {
  sessionEmulation.delete(ownerId);
}

/** Every browser backend just went away (closeAllBrowsers — app teardown, a
 *  settings change, the local-only policy switch). No session can still be ON an
 *  emulated context once its context is gone, and a surviving profile silently
 *  strands the next use of that session id on a headless phone viewport. */
export function clearAllSessionEmulation(): void {
  sessionEmulation.clear();
}

export function _resetSessionEmulationForTest(): void {
  sessionEmulation.clear();
}

export function describeEmulation(profile: EmulationProfile): string {
  return (
    `${profile.viewport.width}x${profile.viewport.height} @${profile.deviceScaleFactor}x, ` +
    `isMobile=${profile.isMobile}, hasTouch=${profile.hasTouch}\nUser-Agent: ${profile.userAgent}`
  );
}

const isPositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Turn `emulate` tool args into a profile, or null to CLEAR emulation
 * (device="desktop"), or an error string the caller returns verbatim.
 *
 * A preset supplies every field; explicit width/height/scale/mobile/touch/UA
 * args override individual fields on top of it. Without a preset, width AND
 * height are required — a half-specified viewport is the shape that silently
 * reproduces the desktop rendering.
 */
export function resolveEmulationProfile(
  args: Record<string, unknown>,
  defaultUserAgent: string,
): { profile: EmulationProfile | null } | { error: string } {
  const device = args.device === undefined ? undefined : String(args.device).toLowerCase();
  if (device === "desktop") return { profile: null };
  if (device !== undefined && !(device in EMULATION_PRESETS)) {
    return {
      error:
        `Unknown device "${device}". Valid devices: ${Object.keys(EMULATION_PRESETS).join(", ")}, desktop ` +
        `(desktop clears emulation). Or omit 'device' and pass viewport_width + viewport_height.`,
    };
  }
  const base: EmulationProfile = device
    ? { ...EMULATION_PRESETS[device], viewport: { ...EMULATION_PRESETS[device].viewport } }
    : {
        viewport: { width: 0, height: 0 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        userAgent: defaultUserAgent,
      };
  if (args.viewport_width !== undefined) base.viewport.width = Number(args.viewport_width);
  if (args.viewport_height !== undefined) base.viewport.height = Number(args.viewport_height);
  if (args.device_scale_factor !== undefined) base.deviceScaleFactor = Number(args.device_scale_factor);
  if (args.is_mobile !== undefined) base.isMobile = args.is_mobile === true || args.is_mobile === "true";
  if (args.has_touch !== undefined) base.hasTouch = args.has_touch === true || args.has_touch === "true";
  if (args.user_agent !== undefined) base.userAgent = String(args.user_agent);
  if (!device && args.viewport_width === undefined && args.viewport_height === undefined
    && args.user_agent === undefined && args.is_mobile === undefined
    && args.has_touch === undefined && args.device_scale_factor === undefined) {
    return {
      error:
        "emulate needs something to emulate: pass device='iphone'|'android'|'ipad' (or 'desktop' to clear), " +
        "or viewport_width + viewport_height (optionally with user_agent / is_mobile / has_touch / device_scale_factor).",
    };
  }
  if (!isPositiveNumber(base.viewport.width) || !isPositiveNumber(base.viewport.height)) {
    return { error: "emulate needs a positive viewport_width AND viewport_height (or a 'device' preset that supplies them)." };
  }
  if (base.viewport.width > 4096 || base.viewport.height > 4096) {
    return { error: "emulate viewport is capped at 4096x4096." };
  }
  if (!isPositiveNumber(base.deviceScaleFactor) || base.deviceScaleFactor > 5) {
    return { error: "emulate device_scale_factor must be a number between 0 and 5." };
  }
  if (!base.userAgent) return { error: "emulate user_agent cannot be empty." };
  return { profile: base };
}

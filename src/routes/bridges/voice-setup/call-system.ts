// The voice system this desktop's calls need, as one thing a paired phone can
// read and start (agentxos VOICE_SYSTEM_PATH / VOICE_SYSTEM_START_PATH, through
// the device http tunnel: broker-transport/device-paths.ts).
//
// The phone names no tier. The saved voice decides: a cloned voice needs its
// clone engine and Lite (the speech server that dispatches to it), any other
// sidecar voice needs Lite, and the in-process engine needs nothing. So the
// phone can start what the user already chose and installed, and nothing else:
// install, repair and stop stay on the desktop's Settings. The agent cannot
// reach these routes at all: they sit under /api/voices/setup, which
// rbac-agent-denials.ts refuses it.
//
// A cold start takes minutes and a tunnel request gives up after seconds, so a
// start answers at once with "starting" and runs on; the phone reads the status
// until it settles.

import type { RouteHandler } from "../../../server-context.js";
import { jsonResponse } from "../../../server-utils.js";
import { createLogger } from "../../../logger.js";
import { resolveVoiceSettings } from "../../../voice/voice-session/settings.js";
import type { VoiceSystemStatus } from "../../../broker-transport/vendor/voice.js";
import { VOICE_SYSTEM_PATH, VOICE_SYSTEM_START_PATH } from "../../../broker-transport/vendor/voice.js";
import { tierById, type VoiceTier } from "./tiers.js";
import { isInstalled, probeHealth } from "./detection.js";
import { startTierAndWait, type StartOutcome } from "./process-control.js";
import { startFailureSummary } from "./handlers.js";

const logger = createLogger("routes.bridges.voice-setup.call-system");

/** The tiers a call needs for this engine and saved voice, in start order;
 *  null when calls run in-process and need none. */
export function callSystemTiers(engine: string, ttsVoice: string | undefined): VoiceTier[] | null {
  if (engine !== "python") return null;
  const clone = ttsVoice?.startsWith("vx:") ? "studio-vox" : ttsVoice?.startsWith("cb:") ? "studio" : null;
  return ["lite", clone].flatMap((id) => {
    const tier = id ? tierById(id) : undefined;
    return tier ? [tier] : [];
  });
}

export interface CallSystemDeps {
  tiers: () => VoiceTier[] | null;
  installed: (tier: VoiceTier) => boolean;
  healthy: (tier: VoiceTier) => Promise<boolean>;
  start: (tier: VoiceTier) => Promise<StartOutcome>;
}

export interface CallSystem {
  status(): Promise<VoiceSystemStatus>;
  /** Start what is not running, in the background; the status as of now. */
  start(): Promise<VoiceSystemStatus>;
}

export function createCallSystem(deps: CallSystemDeps): CallSystem {
  let starting: Promise<void> | null = null;
  let lastFailure: string | null = null;

  async function status(): Promise<VoiceSystemStatus> {
    const tiers = deps.tiers();
    if (tiers === null || tiers.length === 0) return { state: "built-in", label: "Built-in voice" };
    const label = tiers[tiers.length - 1]!.label;
    const missing = tiers.find((t) => !deps.installed(t));
    if (missing) return { state: "not-installed", label, message: `${missing.label} is not installed on this computer. Install it from Settings → Media → Voice System there.` };
    if (starting) return { state: "starting", label };
    const up = await Promise.all(tiers.map(deps.healthy));
    if (up.every(Boolean)) return { state: "running", label };
    return lastFailure ? { state: "failed", label, message: lastFailure } : { state: "stopped", label };
  }

  async function startAll(tiers: VoiceTier[]): Promise<void> {
    for (const tier of tiers) {
      const outcome = await deps.start(tier);
      if (!outcome.ok) {
        // The summary's first line says what happened; the log tail stays on the desktop.
        lastFailure = `${tier.label} ${startFailureSummary(tier.id, outcome).split("\n")[0]}`;
        logger.warn(`[call-system] start from the phone failed: ${lastFailure}`);
        return;
      }
    }
    logger.info(`[call-system] started from the phone: ${tiers.map((t) => t.id).join(" + ")}`);
  }

  async function start(): Promise<VoiceSystemStatus> {
    const now = await status();
    if (now.state !== "stopped" && now.state !== "failed") return now;
    lastFailure = null;
    starting = startAll(deps.tiers()!).finally(() => { starting = null; });
    return status();
  }

  return { status, start };
}

const callSystem = createCallSystem({
  tiers: () => {
    const settings = resolveVoiceSettings();
    return callSystemTiers(settings.engine, settings.ttsVoice);
  },
  installed: isInstalled,
  healthy: async (tier) => (await probeHealth(tier.healthUrl)).ok,
  start: startTierAndWait,
});

export const handleCallSystemRoutes: RouteHandler = async (method, url, req, res) => {
  if (method === "GET" && url.pathname === VOICE_SYSTEM_PATH) {
    jsonResponse(res, 200, await callSystem.status(), req);
    return true;
  }
  if (method === "POST" && url.pathname === VOICE_SYSTEM_START_PATH) {
    jsonResponse(res, 200, await callSystem.start(), req);
    return true;
  }
  return false;
};

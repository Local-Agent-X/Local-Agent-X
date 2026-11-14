/**
 * Voice sidecars the user switched on to start with the app (the
 * `voiceSidecarAutoStart` setting, the switch beside each sidecar's Start
 * button). Off for every sidecar unless the user turns it on: each one loads a
 * model onto the GPU.
 *
 * Runs once, shortly after boot, after the orphan reap. A sidecar already
 * answering on its port is adopted, not started twice (startTierAndWait).
 */
import { createLogger } from "../../../logger.js";
import { loadSettings } from "../../../settings.js";
import { isInstalled } from "./detection.js";
import { startTierAndWait, type StartOutcome } from "./process-control.js";
import { tierById } from "./tiers.js";

const logger = createLogger("voice-setup.auto-start");

/** The sidecars a user may set to start with the app, in start order. */
export const AUTO_START_TIERS = ["lite", "studio", "studio-vox"] as const;

/**
 * The tiers to start for what the user switched on, in start order. Studio and
 * Studio-Vox are clone workers Lite hands synthesis to, so either one brings
 * Lite with it, as their Start button does (handlers.ts).
 */
export function autoStartOrder(wanted: readonly string[]): string[] {
  const on = new Set(wanted.filter((id) => (AUTO_START_TIERS as readonly string[]).includes(id)));
  if (on.has("studio") || on.has("studio-vox")) on.add("lite");
  return AUTO_START_TIERS.filter((id) => on.has(id));
}

export interface AutoStartDeps {
  wanted: () => readonly string[];
  installed: (tierId: string) => boolean;
  start: (tierId: string) => Promise<StartOutcome>;
}

const defaultDeps: AutoStartDeps = {
  wanted: () => {
    const v = loadSettings().voiceSidecarAutoStart;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  },
  installed: (id) => { const t = tierById(id); return !!t && isInstalled(t); },
  start: (id) => startTierAndWait(tierById(id)!),
};

/** Start each switched-on sidecar, one at a time. Returns the ids that are up. */
export async function autoStartVoiceSidecars(deps: AutoStartDeps = defaultDeps): Promise<string[]> {
  const up: string[] = [];
  for (const id of autoStartOrder(deps.wanted())) {
    if (!deps.installed(id)) { logger.warn(`[voice-setup] ${id} is set to start with the app but is not installed`); continue; }
    const outcome = await deps.start(id);
    if (outcome.ok) up.push(id);
    else logger.warn(`[voice-setup] ${id} did not start with the app: ${outcome.reason}`);
  }
  if (up.length > 0) logger.info(`[voice-setup] started with the app: ${up.join(", ")}`);
  return up;
}

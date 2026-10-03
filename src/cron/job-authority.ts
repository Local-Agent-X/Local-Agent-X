/**
 * A mission's own autonomy profile (CronJob.profile) is authority the user
 * grants: under it the unattended run takes actions the global profile would
 * stop to ask about. The grant covers what the mission does, so it stands only
 * while that stays what the user saw: the prompt it runs and the model that
 * runs it. A change to either, or to the profile itself, comes from the user
 * (agentMissionRefusal refuses it from the agent). The grant belongs to the
 * computer it was made on: a mission arriving from the sync repo runs with the
 * profile this computer gave the same mission, if any, never with the one the
 * repo carries (sync/pull-files/pull-misc.ts).
 */
import type { CronJob } from "./cron-service-types.js";

/** The fields that decide what a mission does when it runs. */
export const MISSION_CONTENT_FIELDS = ["prompt", "provider", "model"] as const;

/** Whether applying `changes` to `job` would change what it does when it runs. */
export function changesMissionContent(job: CronJob, changes: Record<string, unknown>): boolean {
  return MISSION_CONTENT_FIELDS.some((f) => f in changes && changes[f] !== job[f]);
}

/**
 * Why the agent may not apply `changes` to `job`, or null when it may. `job`
 * is the mission the changes land on: none for a new mission, and for a create
 * under a name already in use, that mission, whose prompt and schedule the
 * create rewrites (CronService.create). Everything else the agent may change.
 */
export function agentMissionRefusal(changes: Record<string, unknown>, job: CronJob | null | undefined): string | null {
  if (changes.profile !== undefined) {
    return "Only the user can give a mission its own autonomy profile, on the Missions page. Without one, the mission runs under the user's own profile.";
  }
  if (job?.profile && changesMissionContent(job, changes)) {
    return `Mission "${job.name}" runs with its own autonomy profile ("${job.profile}"), which the user granted for what it does now. Only the user can change its prompt or model, on the Missions page.`;
  }
  return null;
}

/**
 * The profile `incoming` may run with on this computer: the one this
 * computer's own copy of the mission was granted, while the mission still does
 * the same thing. The incoming copy's own profile never counts.
 */
export function locallyGrantedProfile(incoming: CronJob, local: CronJob | undefined): CronJob["profile"] {
  if (!local || MISSION_CONTENT_FIELDS.some((f) => local[f] !== incoming[f])) return undefined;
  return local.profile;
}

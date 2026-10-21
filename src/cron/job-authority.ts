/**
 * A mission's own autonomy profile (CronJob.profile), its use of the user's
 * signed-in browser (CronJob.useSignedInBrowser) and its key plan
 * (CronJob.secretPlan, job-secret-plan.ts) are authority the user grants:
 * under the first the unattended run takes actions the global profile would
 * stop to ask about, with the second it browses as the user, logged in, and
 * with the third it sends the saved keys the user named, each to its site,
 * without waiting in the inbox. A grant covers what the mission does, so it
 * stands only while that stays what the user saw: the prompt it runs and the
 * model that runs it. A change to either, or to a grant itself, comes from the
 * user (agentMissionRefusal refuses it from the agent; the chat tool adds a
 * key only on the user's yes to a card, cron/secret-plan-card.ts). A grant
 * belongs to the computer it was made on: a mission arriving from the sync repo
 * runs with the grants this computer gave the same mission, if any, never with
 * the ones the repo carries (sync/pull-files/pull-misc.ts).
 */
import type { CronJob } from "./cron-service-types.js";
import { samePlan } from "./job-secret-plan.js";

/** The fields that decide what a mission does when it runs. */
export const MISSION_CONTENT_FIELDS = ["prompt", "provider", "model"] as const;

/** The fields only the user may set: each widens what an unattended run may do. */
export const MISSION_GRANT_FIELDS = ["profile", "useSignedInBrowser", "secretPlan"] as const;

/** The grants a mission holds, as the fields set on it. */
export type MissionGrants = Pick<CronJob, (typeof MISSION_GRANT_FIELDS)[number]>;

/** Whether applying `changes` to `job` would change what it does when it runs. */
export function changesMissionContent(job: CronJob, changes: Record<string, unknown>): boolean {
  return MISSION_CONTENT_FIELDS.some((f) => f in changes && changes[f] !== job[f]);
}

function heldGrants(job: CronJob): string[] {
  const held: string[] = [];
  if (job.profile) held.push(`its own autonomy profile ("${job.profile}")`);
  if (job.useSignedInBrowser) held.push("your signed-in browser");
  if (job.secretPlan?.length) held.push(`saved keys you named for it (${job.secretPlan.map((p) => p.name).join(", ")})`);
  return held;
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
  if (changes.useSignedInBrowser !== undefined) {
    return "Only the user can let a mission browse with their signed-in browser, on the Missions page. Without that, the mission browses on its own profile, with no saved logins.";
  }
  if (changes.secretPlan !== undefined) {
    return "Only the user can choose the saved keys a mission may send, on the Missions page (\"Keys this job may use\"). Without that, each first send of a key to a site waits in their inbox.";
  }
  const held = job ? heldGrants(job) : [];
  if (job && held.length > 0 && changesMissionContent(job, changes)) {
    return `Mission "${job.name}" runs with ${held.join(" and ")}, which the user granted for what it does now. Only the user can change its prompt or model, on the Missions page.`;
  }
  return null;
}

/**
 * The grants `incoming` may run with on this computer: the ones this
 * computer's own copy of the mission was given, while the mission still does
 * the same thing. The incoming copy's own grants never count.
 */
export function locallyGrantedAuthority(incoming: CronJob, local: CronJob | undefined): MissionGrants {
  if (!local || MISSION_CONTENT_FIELDS.some((f) => local[f] !== incoming[f])) return {};
  return {
    ...(local.profile ? { profile: local.profile } : {}),
    ...(local.useSignedInBrowser ? { useSignedInBrowser: true } : {}),
    ...(local.secretPlan?.length ? { secretPlan: local.secretPlan } : {}),
  };
}

/** Whether `incoming` carries a grant other than the ones this computer gave
 *  (`granted`, from locallyGrantedAuthority): what a sync pull drops. */
export function carriesForeignGrant(incoming: CronJob, granted: MissionGrants): boolean {
  if (incoming.profile !== undefined && incoming.profile !== granted.profile) return true;
  if (incoming.useSignedInBrowser !== undefined && incoming.useSignedInBrowser !== granted.useSignedInBrowser) return true;
  return incoming.secretPlan !== undefined && !samePlan(incoming.secretPlan, granted.secretPlan);
}

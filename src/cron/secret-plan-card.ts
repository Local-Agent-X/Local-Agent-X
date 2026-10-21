// The chat's way to put keys on a scheduled job's plan (job-secret-plan.ts):
// mission_schedule_create / mission_schedule_update take `secrets`, the
// (key, site) pairs the job will need, and each one becomes the user's call.
//
// In an attended chat a pair the vault's ladder allows by a PERSISTENT
// allowance of the user's — the key's own saved site or a host under it
// ("origin"), or the user's own earlier yes for that pair ("approved") — goes
// on the plan as it is. Any other pair is shown on the same card the
// secret-destination gate raises (askSecretDestinationCard), worded for the
// job, and only a yes puts it on the plan. That includes a pair the ladder
// allows only for now: a key this chat captured ("session") or one a running
// operation pre-blessed ("pre_bless") is a temporary allowance, and the plan
// is permanent, so it must not inherit one without the user saying so. A yes is kept on the JOB, never in
// the vault (approveDestination): it lets that job's runs send that key there
// and nothing else. With no one watching (a delegated worker, an api call),
// nothing is added: a job cannot grant itself keys, so the result says where
// the user adds them (the Missions page).

import type { CronJob } from "./cron-service-types.js";
import type { CronService } from "./cron-service.js";
import { describePair, parseSecretPlanPair, planHolds, type SecretPlanPair } from "./job-secret-plan.js";
import { getSecretsStoreSingleton, type DestinationDecision } from "../secrets.js";
import { askSecretDestinationCard, canAskInChat } from "../secret-destination-gate.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";

/** The `secrets` argument both mission tools take. */
export const SECRET_PLAN_PARAMETER = {
  type: "array",
  description:
    "Optional: every saved key the job will send, each with its one site. The user approves each pair on a card; " +
    "a key or site left off waits in their inbox at run time.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "Saved key name" },
      destination: { type: "string", description: "e.g. https://api.example.com" },
    },
    required: ["name", "destination"],
  },
} as const;

/** The ladder's answers that stand for the user's lasting yes, and so may go
 *  on a permanent plan without a card. "session" and "pre_bless" last only as
 *  long as the chat or the operation; "planned" is a plan already. */
const PERSISTENT_ALLOWANCES: ReadonlySet<DestinationDecision> = new Set<DestinationDecision>(["origin", "approved"]);

interface Outcome {
  added: SecretPlanPair[];
  /** "<KEY> at <site>: why it was not added". */
  notAdded: string[];
}

function cardContext(job: CronJob, pair: SecretPlanPair): string {
  return `Let scheduled job "${job.name}" send ${pair.name} to ${pair.destination} when it runs. ` +
    "This is for this job only: its runs use the key there without asking you again, and nothing else gains it. " +
    "The value goes from the vault straight there; the agent never sees it. You can remove it on the Missions page.";
}

/** Ask for the pairs one by one and say which went on the plan. */
async function decidePairs(job: CronJob, requested: unknown[], call: Record<string, unknown>, toolName: string): Promise<Outcome> {
  const outcome: Outcome = { added: [], notAdded: [] };
  const store = getSecretsStoreSingleton();
  const sessionId = sessionIdOf(call) ?? "";
  for (const entry of requested) {
    const pair = parseSecretPlanPair(entry);
    if (typeof pair === "string") { outcome.notAdded.push(pair); continue; }
    if (planHolds(job.secretPlan, pair.name, pair.destination) || planHolds(outcome.added, pair.name, pair.destination)) continue;
    if (!store?.has(pair.name)) { outcome.notAdded.push(`${describePair(pair)}: there is no saved key named ${pair.name} (request_secret asks the user for it)`); continue; }
    const allowed = PERSISTENT_ALLOWANCES.has(store.destinationDecision(pair.name, pair.destination, { sessionId }));
    const yes = allowed || await askSecretDestinationCard({
      toolName, sessionId, call, context: cardContext(job, pair),
      args: { name: pair.name, destination: pair.destination, job: job.name },
    });
    if (yes) outcome.added.push(pair);
    else outcome.notAdded.push(`${describePair(pair)}: the user said no`);
  }
  return outcome;
}

/**
 * Put the requested pairs on `job`'s plan as the user decides, and return the
 * sentence the tool's result carries about them ("" when none were asked for).
 */
export async function grantSecretPlanFromChat(
  cron: CronService,
  job: CronJob,
  requested: unknown,
  call: Record<string, unknown>,
  toolName: string,
): Promise<string> {
  if (requested === undefined) return "";
  const list = Array.isArray(requested) ? requested : [requested];
  if (list.length === 0) return "";
  if (!canAskInChat(call)) {
    return `\n\nNo keys were added to its plan: a job cannot grant itself keys, and no one is watching this run to approve them. ` +
      `Ask the user to add them on the Missions page ("Keys this job may use" on "${job.name}"); until then each first send waits in their inbox.`;
  }
  const { added, notAdded } = await decidePairs(job, list, call, toolName);
  if (added.length > 0) cron.update(job.id, { secretPlan: [...(job.secretPlan ?? []), ...added] });
  const lines: string[] = [];
  if (added.length > 0) lines.push(`Keys added to its plan (its runs use them there without asking): ${added.map(describePair).join(", ")}.`);
  if (notAdded.length > 0) {
    lines.push(`Not added: ${notAdded.join("; ")}. A run that sends one of these waits in the user's inbox for their yes; do not retry the same pair unchanged.`);
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

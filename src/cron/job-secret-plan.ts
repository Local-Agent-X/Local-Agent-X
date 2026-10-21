// A scheduled job's key plan (CronJob.secretPlan): the (vault key, site) pairs
// the user let THIS job send when it runs. Scheduling a job is the user's yes
// to what it needs, and a job must not stall at 3 a.m. for a key the user
// already named for it — while anything the user did not name still waits in
// their inbox (secret-destination-gate.ts), as before.
//
// The plan is job-scoped: it is the ladder's "planned" rung
// (secret-destinations.ts decideDestination) for the sessions of that job's
// runs only, and never approves a pair in the vault (approveDestination) for
// any other session. Which job a session belongs to is read off the session
// lineage the run-prep sites already record (browser/session-owner-registry.ts):
// a run's session is `cron-<jobId>-<ms>` (cron-session.ts), and every agent or
// delegated worker it spawns is registered as its child, flattened to that root
// (registerChildSessionOwner), so a helper the job spawns sends what the job may.
//
// Like the job's own autonomy profile, a plan is authority only the user grants
// (job-authority.ts): the agent's role cannot set or widen it through the route,
// the chat tool adds a pair only on the user's yes to a card, and sync never
// carries one in.

import { normalizeDestination } from "../secret-destinations.js";
import { resolveBrowserSessionId } from "../browser/session-owner-registry.js";
import { cronJobIdOf } from "./cron-session.js";

export interface SecretPlanPair {
  /** The vault key's name, as the vault holds it (SCREAMING_SNAKE_CASE). */
  name: string;
  /** Where it may go: a normalized origin (normalizeDestination). */
  destination: string;
}

const KEY_NAME = /^[A-Z0-9_]{1,64}$/;

/** A site as a person writes it: a bare host ("api.supabase.com") means https. */
function siteOf(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  return normalizeDestination(text.includes("://") ? text : `https://${text}`);
}

/** One pair from a client or a tool call, or why it is not one. */
export function parseSecretPlanPair(input: unknown): SecretPlanPair | string {
  const raw = (input ?? {}) as { name?: unknown; destination?: unknown };
  const name = typeof raw.name === "string" ? raw.name.trim().toUpperCase() : "";
  if (!KEY_NAME.test(name)) return `"${String(raw.name ?? "")}" is not a saved key's name`;
  const destination = typeof raw.destination === "string" ? siteOf(raw.destination) : undefined;
  if (!destination) return `"${String(raw.destination ?? "")}" is not a site (for ${name})`;
  return { name, destination };
}

/** A whole plan from a client, normalized and without repeats, or why not. */
export function parseSecretPlan(input: unknown): { plan: SecretPlanPair[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "secretPlan must be a list of { name, destination }" };
  const plan: SecretPlanPair[] = [];
  for (const entry of input) {
    const pair = parseSecretPlanPair(entry);
    if (typeof pair === "string") return { error: `secretPlan: ${pair}` };
    if (!planHolds(plan, pair.name, pair.destination)) plan.push(pair);
  }
  return { plan };
}

/** Whether the plan names this key for this (normalized) destination. */
export function planHolds(plan: readonly SecretPlanPair[] | undefined, name: string, destination: string): boolean {
  return !!plan?.some((p) => p.name === name && p.destination === destination);
}

/** Two plans hold the same pairs, in any order. */
export function samePlan(a: readonly SecretPlanPair[] | undefined, b: readonly SecretPlanPair[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((p) => planHolds(right, p.name, p.destination));
}

let planOfJob: (jobId: string) => readonly SecretPlanPair[] | undefined = () => undefined;

/** The server's answer to "what does this job's plan hold now" (registerCronRunner):
 *  read live, so a pair the user removes stops the next send, mid-run included. */
export function setJobSecretPlanSource(source: (jobId: string) => readonly SecretPlanPair[] | undefined): void {
  planOfJob = source;
}

/** The scheduled job a session belongs to: a run's own session, or any agent
 *  or worker session registered under it. Undefined for every other session. */
export function jobOfSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return cronJobIdOf(resolveBrowserSessionId(sessionId));
}

/** The ladder's "planned" rung: this session is one of a job's runs, and that
 *  job's plan names this key for this (normalized) destination. */
export function plannedForSession(sessionId: string | undefined, name: string, destination: string): boolean {
  const jobId = jobOfSession(sessionId);
  return !!jobId && planHolds(planOfJob(jobId), name, destination);
}

/** "<KEY> at <site>", for a person or a prompt. Names only, never values. */
export function describePair(pair: SecretPlanPair): string {
  return `${pair.name} at ${pair.destination}`;
}

/** The block a run's instructions carry, naming the keys its plan holds. Empty with no plan. */
export function secretPlanPromptBlock(plan: readonly SecretPlanPair[] | undefined): string {
  if (!plan || plan.length === 0) return "";
  return [
    "",
    "## Keys this job may use",
    "The user approved these saved keys for this job, each for one site:",
    ...plan.map((p) => `- ${describePair(p)}`),
    "Use these keys for these sites: in http_request write the key as {{NAME}} and its value is filled in on the way out; you never see it.",
    "Any other key, or one of these at another site, is not part of this job: that call waits in the user's inbox for their yes.",
    "",
  ].join("\n");
}

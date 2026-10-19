/**
 * Clearing a scheduled job's own browser profile: the one place its sign-ins
 * are wiped, for the Missions page's "Clear sign-ins" and for a deleted job
 * (CronService.delete). The profile is the pair session-owner-registry.ts
 * names from the job id — the CDP arm's Chrome profile dir
 * (`jobBrowserProfileDir`) and the in-app partition (`jobBrowserPartition`) —
 * and both go, after every live browser on the profile is closed. The user's
 * signed-in profile is never named here, and the dir must be exactly one entry
 * under browser-job-profiles or nothing is removed.
 */

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { browserClearPartition } from "./bridge-client.js";
import { BridgeUnavailableError } from "./bridge-client-contract.js";
import { closeJobProfileBrowsers } from "./instance.js";
import { jobBrowserPartition, jobBrowserProfileDir } from "./session-owner-registry.js";

export async function clearJobBrowserProfile(jobId: string): Promise<void> {
  const dir = jobBrowserProfileDir(jobId);
  // An id that sanitizes to nothing names the root itself: every job's profile.
  if (dirname(dir) !== join(getLaxDir(), "browser-job-profiles")) {
    throw new Error(`Refusing to clear browser profile "${dir}": not one job's profile dir`);
  }
  await closeJobProfileBrowsers(jobId);
  // Retries: on Windows a just-closed Chrome can hold its profile's files for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    await browserClearPartition(jobBrowserPartition(jobId));
  } catch (error) {
    // Not under the desktop app: there is no in-app partition to clear.
    if (!(error instanceof BridgeUnavailableError)) throw error;
  }
}

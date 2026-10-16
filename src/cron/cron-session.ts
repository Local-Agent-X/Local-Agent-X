// A scheduled run's transcript session is `cron-<jobId>-<startMs>`: the cron
// runner names it here, and every reader that needs the job back from a
// session id (the run's report link, the inbox's per-job dedupe) reads it here.

export function cronSessionId(jobId: string, startedAt: number = Date.now()): string {
  return `cron-${jobId}-${startedAt}`;
}

/** The job a cron run's session belongs to, or undefined for any other session. */
export function cronJobIdOf(sessionId: string | undefined): string | undefined {
  return sessionId?.match(/^cron-(.+)-\d+$/)?.[1] || undefined;
}

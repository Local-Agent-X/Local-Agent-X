/**
 * Stall watchdog — periodic sweep that surfaces silent agents.
 *
 * Chunks 1-2 gave agents a `reportsTo` chain and an `agent_escalate`
 * tool. Both rely on the agent actually noticing it's stuck and calling
 * the tool. This service is the safety net for the case where the agent
 * never gets that far: the run silently dies, the canonical loop hangs,
 * the agent forgets to escalate after a checkout. Every 15 minutes we
 * walk every project roster, compute last-meaningful-activity per
 * agent, and route stale ones through performEscalation to the manager
 * (or past the manager to the user when staleness exceeds 2x the
 * threshold).
 *
 * Not a CronService job. CronService is for user-authored prompt jobs;
 * this is infrastructure that runs on a hardcoded interval whether the
 * user has scheduled anything or not.
 *
 * Dedup: each escalation stamps roster.lastEscalatedAt. The next tick
 * inside that window skips the agent entirely — no point recomputing
 * activity for someone we just pinged.
 */

import {
  AgentRunStore,
  AgentTemplateStore,
  IssueStore,
  type Issue,
} from "../agent-store.js";
import { ProjectRosterStore, type ProjectRoster } from "../project-rosters.js";
import { performEscalation } from "./escalation-core.js";
import { createLogger } from "../logger.js";

const logger = createLogger("watchdog");

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_THRESHOLD_HOURS = 24;
const HOUR_MS = 3_600_000;

export class WatchdogService {
  private static instance: WatchdogService | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;

  private constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  static getInstance(intervalMs: number = DEFAULT_INTERVAL_MS): WatchdogService {
    if (!WatchdogService.instance) {
      WatchdogService.instance = new WatchdogService(intervalMs);
    }
    return WatchdogService.instance;
  }

  /** Test-only — stops any active timer and clears the singleton so
   *  the next getInstance() rebuilds with a fresh interval. */
  static _resetForTest(): void {
    if (WatchdogService.instance) WatchdogService.instance.stop();
    WatchdogService.instance = null;
  }

  start(): void {
    if (this.timer) return; // already started — idempotent
    this.timer = setInterval(() => { void this.tickNow(); }, this.intervalMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      // Don't keep the event loop alive on its own — the watchdog is
      // infrastructure that should follow the server's lifetime, not
      // extend it.
      (this.timer as unknown as { unref: () => void }).unref();
    }
    logger.info(`[watchdog] started (${Math.round(this.intervalMs / 60_000)}m interval)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info("[watchdog] stopped");
  }

  isRunning(): boolean { return this.running; }

  /** Single sweep. Public so tests + the manual smoke can trigger
   *  without waiting for the 15-min cadence. Overlap-safe: a tick that
   *  fires while a prior tick is still in flight is dropped. */
  async tickNow(): Promise<void> {
    if (this.running) {
      logger.debug("[watchdog] tick skipped — prior tick still running");
      return;
    }
    this.running = true;
    try {
      await this.scanAndEscalate();
    } catch (e) {
      logger.warn(`[watchdog] tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async scanAndEscalate(): Promise<void> {
    const rosters = ProjectRosterStore.getInstance().listAll();
    if (rosters.length === 0) return;

    const issueStore = IssueStore.getInstance();
    const runStore = AgentRunStore.getInstance();
    const templateStore = AgentTemplateStore.getInstance();
    // One pass over runs; the watchdog scans every roster, so amortize
    // the read instead of doing it per-roster. 500 is the same ceiling
    // AgentRunStore.getChildren uses.
    const { runs } = runStore.list({ limit: 500 });

    for (const roster of rosters) {
      try {
        await this.evaluateRoster(roster, { issueStore, runs, templateStore });
      } catch (e) {
        // One failed eval shouldn't abort the whole sweep — log and
        // continue. Exceptions here are typically transient (template
        // deleted mid-tick, etc.).
        logger.warn(`[watchdog] roster ${roster.agentId}@${roster.projectId} eval failed: ${(e as Error).message}`);
      }
    }
  }

  private async evaluateRoster(
    roster: ProjectRoster,
    deps: {
      issueStore: IssueStore;
      runs: ReturnType<AgentRunStore["list"]>["runs"];
      templateStore: AgentTemplateStore;
    },
  ): Promise<void> {
    const { issueStore, runs, templateStore } = deps;
    const threshold = roster.stallThresholdHours ?? DEFAULT_THRESHOLD_HOURS;
    const thresholdMs = threshold * HOUR_MS;
    const userThresholdMs = thresholdMs * 2;
    const now = Date.now();

    // Dedup BEFORE the activity scan — if we just escalated, recomputing
    // activity is wasted work.
    if (roster.lastEscalatedAt && now - roster.lastEscalatedAt < thresholdMs) {
      return;
    }

    // Active iff at least one open assigned issue in this project.
    // Idle agents (freshly hired, no work) are not "stale" — they're
    // just waiting for a task.
    const openIssues = openIssuesFor(roster, issueStore);
    if (openIssues.length === 0) return;

    const lastActivity = computeLastActivity(roster, openIssues, runs);
    const elapsedMs = now - lastActivity;
    if (elapsedMs < thresholdMs) return; // not stale yet

    const tpl = templateStore.get(roster.agentId);
    const name = tpl?.name ?? roster.agentId;
    const hoursStale = Math.round(elapsedMs / HOUR_MS);
    const oldestOpen = openIssues
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    const issueRef = oldestOpen?.id ?? "(no anchor)";

    const escalateToUser = elapsedMs >= userThresholdMs;
    const request = escalateToUser
      ? {
          callerAgentId: roster.agentId,
          to: "user",
          urgency: "high" as const,
          context:
            `${name} has been stale for ${hoursStale}h (2x threshold). ` +
            `Open issue: ${issueRef}. Manager was already notified; ` +
            `this is the second-tier wake.`,
          issueId: oldestOpen?.id,
        }
      : {
          callerAgentId: roster.agentId,
          to: "manager",
          urgency: "high" as const,
          context:
            `Your report ${name} hasn't made progress in ${hoursStale}h. ` +
            `Open issue: ${issueRef}.`,
          issueId: oldestOpen?.id,
        };

    const outcome = await performEscalation(request);
    if (!outcome.ok) {
      logger.warn(`[watchdog] escalation for ${name}@${roster.projectId} failed: ${outcome.message}`);
      return;
    }
    logger.info(`[watchdog] ${name}@${roster.projectId} stale ${hoursStale}h → ${request.to}; ${outcome.message}`);

    // Stamp dedup so the next tick inside this window skips us.
    ProjectRosterStore.getInstance().patch(roster.projectId, roster.agentId, {
      lastEscalatedAt: Date.now(),
    });
  }
}

function openIssuesFor(roster: ProjectRoster, store: IssueStore): Issue[] {
  return store
    .list({ assignee: roster.agentId })
    .filter((i) =>
      i.projectId === roster.projectId &&
      i.status !== "done" &&
      i.status !== "cancelled",
    );
}

function computeLastActivity(
  roster: ProjectRoster,
  openIssues: Issue[],
  runs: ReturnType<AgentRunStore["list"]>["runs"],
): number {
  let last = 0;
  for (const r of runs) {
    if (r.templateId !== roster.agentId) continue;
    if (r.completedAt > last) last = r.completedAt;
  }
  for (const i of openIssues) {
    if (i.updatedAt > last) last = i.updatedAt;
    for (const c of i.comments) {
      if (c.author === roster.agentId && c.createdAt > last) last = c.createdAt;
    }
  }
  // Freshly-hired agent with work but zero activity is exactly the
  // case the watchdog catches — fall back to the roster's createdAt so
  // the staleness clock starts ticking from when we hired them.
  return last === 0 ? roster.createdAt : last;
}

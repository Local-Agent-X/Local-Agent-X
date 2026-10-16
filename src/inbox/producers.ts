// Item builders for each producer. The owners (escalation-core, the session
// bridge observer, the cron executor, the agent-result listener,
// update-service) decide WHEN something happened; these decide what the user
// reads, how it dedupes and whether it needs them. A call parked for the
// user's yes has its own builders in approvals.ts.

import { postToInbox, resolveInboxWhere } from "./index.js";
import type { InboxLink } from "./types.js";

/** Whitespace collapsed to one line, cut at `max` characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const LABEL_CHARS = 80;

/** `Background task "build the …"`: a run named by the first line of its task. */
export function runLabel(kind: string, task: string): string {
  const line = task.replace(/<\/?scheduled_task>/g, "").trim().split("\n")[0]?.trim() ?? "";
  return line ? `${kind} "${clip(line, LABEL_CHARS)}"` : kind;
}

export function inboxAgentEscalation(e: {
  fromAgentId: string;
  fromName: string;
  context: string;
  urgency: "normal" | "high";
  issueId?: string;
}): void {
  postToInbox({
    kind: "agent-message",
    title: e.urgency === "high" ? `${e.fromName} needs you now` : `${e.fromName} needs you`,
    body: e.context,
    needsYou: true,
    link: { agentId: e.fromAgentId, ...(e.issueId ? { issueId: e.issueId } : {}) },
  });
}

export type JobOutcome = "completed" | "partial" | "failed" | "cancelled";

const OUTCOME_PHRASE: Record<JobOutcome, string> = {
  completed: "finished",
  partial: "stopped before finishing",
  failed: "failed",
  cancelled: "was cancelled",
};

/**
 * A job that ran without the user watching. Failed and partial runs need
 * them; a finished or cancelled one is informational. `key` makes a replayed
 * terminal event (recovery, a second observer pass) update the same item.
 */
export function inboxJobResult(j: {
  label: string;
  outcome: JobOutcome;
  summary: string;
  key: string;
  link?: InboxLink;
}): void {
  postToInbox({
    kind: "job",
    title: `${j.label} ${OUTCOME_PHRASE[j.outcome]}`,
    body: j.summary,
    needsYou: j.outcome === "failed" || j.outcome === "partial",
    key: j.key,
    ...(j.link ? { link: j.link } : {}),
  });
}

export function inboxUpdateAvailable(u: { version: string; commit: string; notes: string }): void {
  postToInbox({
    kind: "update",
    title: `Update available: ${u.version}`,
    body: [u.commit ? `Commit ${u.commit}` : "", u.notes].filter(Boolean).join(" — ") || "A newer version is ready to install from Settings.",
    needsYou: false,
    key: `update:${u.version}`,
  });
}

/** The install is current: an open update notice is no longer true. */
export function inboxUpdateCurrent(): void {
  resolveInboxWhere((item) => item.kind === "update");
}

// Item builders for each producer. The owners (escalation-core, the session
// bridge observer, the cron executor, the agent-result listener,
// update-service, user-notice) decide WHEN something happened; these decide what the user
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

/** The agent writing to the user from a run with no chat in front of them
 *  (a reminder from a scheduled mission, a result they asked to be told
 *  about): the notify_user tool. Pinned until they read it and mark it done;
 *  the phone rings for it when they turned on "Your agent writes to you". */
export function inboxAgentNote(n: { title: string; body: string }): boolean {
  return postToInbox({ kind: "agent-message", title: n.title, body: n.body, needsYou: true }) !== null;
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

/** A one-time notice the app owes the user (a default it changed under them):
 *  recorded durably here, so it is read on whichever screen they open next.
 *  Returns whether the inbox took it. */
const WITHHELD_OUTPUT_CHARS = 8000;

/**
 * The output of a command that worked on a vault secret's value in its own
 * text (tools/shell-secret-env.ts secretManipulation): delivered to the
 * user here, never to the model, scrubbed as every reader's copy is. `key`
 * is the call's, so a background process's updates replace its item.
 */
export function inboxWithheldOutput(o: { key: string; program: string; secrets: string[]; reason: string; exit: string; output: string }): void {
  const body = o.output.length > WITHHELD_OUTPUT_CHARS ? `${o.output.slice(0, WITHHELD_OUTPUT_CHARS)}\n[… ${o.output.length - WITHHELD_OUTPUT_CHARS} more characters]` : o.output;
  postToInbox({
    kind: "notice",
    title: `Output of \`${o.program}\` kept from the agent`,
    body: `${o.reason[0].toUpperCase()}${o.reason.slice(1)} (${o.secrets.join(", ")}), so the agent got only the exit code. ${o.exit}.\n\n${body || "(no output)"}`,
    needsYou: false,
    key: o.key,
  });
}

/** Memory needs the user: a daily snapshot failed its checks, or memory had
 *  to be restored at start (db-backup.ts). `key` keeps one item per cause. */
export function inboxMemoryAlert(a: { key: string; title: string; body: string }): void {
  postToInbox({ kind: "notice", title: a.title, body: a.body, needsYou: true, key: a.key });
}

const lessonKey = (signature: string): string => `lesson:${signature}`;

/**
 * The failure review wrote a lesson for a tool call that keeps failing across
 * chats (server/background-jobs/failure-review.ts). Nothing reaches the agent
 * until the user keeps it, so the item stays until they answer; `key` keeps
 * one item per failure.
 */
export function inboxLessonProposed(l: { signature: string; tool: string; lesson: string; sessions: number }): void {
  postToInbox({
    kind: "notice",
    title: `A lesson is waiting for you: ${l.tool} keeps failing the same way`,
    body: `It failed the same way in ${l.sessions} chats. The note the agent would be shown the next time it happens:\n\n${l.lesson}\n\nKeep or discard it in Settings → Memory → Recurring problems.`,
    needsYou: true,
    key: lessonKey(l.signature),
  });
}

/** The user kept or discarded the lesson: the item asking them is answered. */
export function inboxLessonAnswered(signature: string): void {
  resolveInboxWhere((item) => item.key === lessonKey(signature));
}

export function inboxUserNotice(n: { id: string; text: string }): boolean {
  return postToInbox({ kind: "notice", title: n.text, body: "", needsYou: false, key: `notice:${n.id}` }) !== null;
}

/**
 * Mail the mail watcher judged important (src/server/background-jobs/mail-watch.ts):
 * posted as the agent writing to the user, so it rings the phones that turned
 * on "Your agent writes to you", and a travel change rings through quiet
 * hours. Informational: read is enough. One item per message.
 */
export function inboxImportantMail(m: {
  account: string; id: string; from: string; subject: string; why: string; travel: boolean;
}): boolean {
  const sender = m.from.replace(/\s*<[^<>]*>\s*$/, "").trim() || m.from;
  return postToInbox({
    kind: "agent-message",
    title: clip(`${sender}: ${m.subject}`, 120),
    body: `${m.why}\n\nFrom ${m.from}, "${m.subject}". Ask in chat to read or answer it.`,
    needsYou: false,
    key: `mail:${m.account}:${m.id}`,
    ...(m.travel ? { ringThroughQuietHours: true } : {}),
  }) !== null;
}

/** The morning list of mail that did not need the user right away. */
export function inboxMailDigest(d: { day: string; entries: Array<{ from: string; subject: string }>; skipped: number }): boolean {
  const lines = d.entries.slice(0, 40).map((e) => `• ${clip(e.from.replace(/\s*<[^<>]*>\s*$/, "") || e.from, 40)}: ${clip(e.subject, 80)}`);
  const more = d.entries.length - lines.length + d.skipped;
  const count = d.entries.length + d.skipped;
  return postToInbox({
    kind: "notice",
    title: `Mail digest: ${count} message${count === 1 ? "" : "s"} that didn't need you right away`,
    body: `${lines.join("\n")}${more > 0 ? `\n…and ${more} more` : ""}`,
    needsYou: false,
    key: `mail-digest:${d.day}`,
  }) !== null;
}

/** The mail watcher could not do its job (said at most once a day). */
export function inboxMailWatchProblem(p: { day: string; text: string }): boolean {
  return postToInbox({
    kind: "notice",
    title: "Your mail isn't being checked right now",
    body: `${p.text}\n\nSettings → General → Watching for you.`,
    needsYou: false,
    key: `mail-watch-problem:${p.day}`,
  }) !== null;
}

/** Two plans at the same time (src/calendar/notice.ts, the mail watcher):
 *  the agent writing to the user, so it rings the phone. Read is enough. */
export function inboxPlanClash(c: { key: string; title: string; body: string }): boolean {
  return postToInbox({ kind: "agent-message", title: clip(c.title, 140), body: c.body, needsYou: false, key: c.key }) !== null;
}

/** A commitment is coming up (src/server/background-jobs/plan-reminders.ts). */
export function inboxPlanReminder(r: { key: string; title: string; body: string }): boolean {
  return postToInbox({ kind: "agent-message", title: clip(r.title, 140), body: r.body, needsYou: false, key: r.key }) !== null;
}

/** A flight changed (src/server/background-jobs/travel-watch.ts): rings the
 *  phone even in quiet hours. Read is enough. */
export function inboxTravelChange(t: { key: string; title: string; body: string }): boolean {
  return postToInbox({ kind: "agent-message", title: clip(t.title, 140), body: t.body, needsYou: false, key: t.key, ringThroughQuietHours: true }) !== null;
}

/** A reply the user owes or is owed (src/server/background-jobs/mail-followups.ts).
 *  The agent writing to them, so it rings the phone. Read is enough. */
export function inboxFollowUp(f: { key: string; title: string; body: string }): boolean {
  return postToInbox({ kind: "agent-message", title: clip(f.title, 140), body: f.body, needsYou: false, key: f.key }) !== null;
}

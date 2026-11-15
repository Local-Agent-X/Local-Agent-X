/**
 * Mail watch — the assistant reading new mail so the user does not have to
 * find the important one two days late.
 *
 * Every ~15 minutes (scheduler in ./index.ts) a pass reads what arrived in
 * each connected mailbox since the last pass, asks one model call which of it
 * matters now (a job, a person they know, money or a deadline, a travel
 * change, an appointment; their calendar says when they are busy), raises
 * those in the inbox (the phone rings for them, quiet hours permitting) and
 * keeps the rest for a digest posted when quiet hours end.
 *
 * What bounds it:
 *  - Read-only. The IMAP calls are search, fetch and list; the model call has
 *    no tools and its reply is parsed as data. An email's text cannot make
 *    anything happen (mail-watch-prompt.ts fences it as external content).
 *  - Per-user switches (settings-schema.watchers.ts): off, or local model
 *    only, which never falls back to a cloud model.
 *  - At most MAX_PER_PASS messages per account per pass and DAILY_CALL_CAP
 *    model calls a day; past the cap mail goes to the digest unjudged.
 *  - Failures are told to the user in the inbox (once a day), never dropped.
 */
import { getRuntimeConfig } from "../../config.js";
import { createLogger } from "../../logger.js";
import { OP_TYPE } from "../../ops/op-types.js";
import { isLocalOnlyMode } from "../../local-only-policy.js";
import { eventsBetween, type CalendarWindow } from "../../calendar/index.js";
import { inboxImportantMail, inboxMailDigest, inboxMailWatchProblem, mailAlertKey } from "../../inbox/producers.js";
import { categoryRecord, demoted, listenForRatings, loadRatings, noteAlert, senderRecord } from "./mail-watch-ratings.js";
import { minutesOf } from "../../phone-push/quiet-hours.js";
import type { EmailSummary } from "../../tools/email-imap.js";
import {
  forkReply, LocalModelUnavailableError, reviewFailure, runReviewFork, type ReviewForkDeps,
} from "./review-fork.js";
import {
  addressOf, defaultMailSession, knownSenders, mailAccounts, readNewMail,
  type MailAccount, type MailSessionRunner, type NewMail,
} from "./mail-watch-mail.js";
import {
  MAIL_WATCH_SESSION_PREFIX, MAIL_WATCH_SYSTEM_PROMPT, buildMailWatchMessage, parseMailVerdicts, type MailVerdict,
} from "./mail-watch-prompt.js";
import { recordPlan } from "../../calendar/plans.js";
import {
  SENT_MAIL_SYSTEM_PROMPT, applySentVerdicts, buildSentMessage, checkFollowUps, noteOwed, parseSentVerdicts, readSentMail, type SentBatch,
} from "./mail-followups.js";
import { announceClash } from "../../calendar/notice.js";
import {
  loadMailWatchState, localDay, saveMailWatchState, type MailWatchState,
} from "./mail-watch-state.js";

const logger = createLogger("server.background-jobs.mail-watch");

export const MAIL_WATCH_INTERVAL_MS = 15 * 60 * 1000;
/** Model calls a day. A pass makes one per account with new mail. */
export const DAILY_CALL_CAP = 120;
/** Failed passes in a row before the user is told. */
export const FAILURES_BEFORE_NOTICE = 3;
const FORK_TIMEOUT_MS = 3 * 60 * 1000;
const CALENDAR_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

export interface MailWatchDeps extends ReviewForkDeps {
  now?: () => Date;
  accounts?: () => MailAccount[];
  session?: MailSessionRunner;
  calendar?: (from: Date, to: Date) => Promise<CalendarWindow>;
  runFork?: typeof runReviewFork;
  /** True while a chat turn is running. A local-model pass waits for idle:
   *  it would share the GPU with the turn. */
  foregroundBusy?: () => boolean;
  statePath?: string;
}

let deps: MailWatchDeps | null = null;

export function registerMailWatchRunner(next: MailWatchDeps): void {
  deps = next;
  listenForRatings();
}

export interface MailWatchPassResult {
  skipped?: "no-runner" | "disabled" | "no-account" | "busy";
  read: number;
  important: number;
  failed: boolean;
}

const skip = (reason: MailWatchPassResult["skipped"]): MailWatchPassResult => ({ skipped: reason, read: 0, important: 0, failed: false });

export async function runMailWatchPass(): Promise<MailWatchPassResult> {
  if (!deps) return skip("no-runner");
  const d = deps;
  const cfg = getRuntimeConfig();
  if (!cfg.mailWatchEnabled) return skip("disabled");
  const accounts = (d.accounts ?? mailAccounts)();
  if (accounts.length === 0) return skip("no-account");
  const localOnly = cfg.mailWatchLocalOnly || isLocalOnlyMode(cfg);
  if (localOnly && d.foregroundBusy?.()) return skip("busy");

  const now = (d.now ?? (() => new Date()))();
  const state = loadMailWatchState(d.statePath);
  const day = localDay(now);
  if (state.usage.day !== day) state.usage = { day, calls: 0 };
  const result: MailWatchPassResult = { read: 0, important: 0, failed: false };
  // Before reading: the morning digest is what waited overnight, and what
  // this pass queues waits for tomorrow's.
  postDigestIfDue(state, now, cfg.quietHoursEnd);
  try {
    for (const account of accounts) await watchAccount(account, { d, state, now, localOnly, result });
    state.failures = 0;
  } catch (e) {
    result.failed = true;
    state.failures++;
    noteFailure(e as Error, state, day);
  }
  saveMailWatchState(state, d.statePath);
  return result;
}

interface PassContext {
  d: MailWatchDeps;
  state: MailWatchState;
  now: Date;
  localOnly: boolean;
  result: MailWatchPassResult;
}

/** One account: read, judge, post. The checkpoint moves only once the mail
 *  it covers is judged or queued, so a failed pass reads it again. */
async function watchAccount(account: MailAccount, ctx: PassContext): Promise<void> {
  const { d, state, now } = ctx;
  const followUps = getRuntimeConfig().followUpsEnabled;
  const { mail, known, sent } = await (d.session ?? defaultMailSession)(account.creds, async (s) => {
    const read = await readNewMail(s, state.accounts[account.id], now);
    const senders = read.messages.map((m) => addressOf(m.from));
    const knownSet = await knownSenders(s, senders, state, now.getTime());
    // Replies owed and awaited, checked on the same connection (mail-followups.ts).
    const sentBatch = followUps ? await readSentMail(s, state, account.id, now) : null;
    if (followUps) await checkFollowUps(s, state, account.id, sentBatch?.folder ?? null, now);
    return { mail: read, known: knownSet, sent: sentBatch };
  });
  state.digest.skipped += mail.skipped;
  ctx.result.read += mail.messages.length;
  if (mail.messages.length > 0) {
    if (state.usage.calls >= DAILY_CALL_CAP) {
      queueForDigest(state, mail.messages);
      tellOnce(state, localDay(now), `The mail check reached its limit of ${DAILY_CALL_CAP} checks today, so new mail goes to tomorrow's digest unsorted.`);
    } else {
      state.usage.calls++;
      ctx.result.important += await judgeAndPost(account, mail, known, ctx);
    }
  }
  state.accounts[account.id] = mail.checkpoint;
  if (sent && sent.messages.length > 0 && state.usage.calls < DAILY_CALL_CAP) {
    state.usage.calls++;
    await judgeSent(account, sent, ctx);
  }
}

/** One model call over the user's new sent mail: promises go on the
 *  calendar, questions wait for an answer (mail-followups.ts). */
async function judgeSent(account: MailAccount, sent: SentBatch, ctx: PassContext): Promise<void> {
  const { d, now } = ctx;
  const outcome = await (d.runFork ?? runReviewFork)({
    forkSessionId: `${MAIL_WATCH_SESSION_PREFIX}sent-${now.getTime()}-${account.id}`,
    message: buildSentMessage(now, sent),
    systemPrompt: SENT_MAIL_SYSTEM_PROMPT,
    section: { id: "mail-watch-sent", label: "Mail Watch (sent)" },
    tools: [],
    opType: OP_TYPE.mailWatch,
    maxIterations: 2,
    timeoutMs: FORK_TIMEOUT_MS,
    ...(ctx.localOnly ? { localOnly: {} } : {}),
  }, d);
  const failure = reviewFailure(outcome);
  if (failure) throw new Error(`the sent-mail check ${failure}`);
  const verdicts = parseSentVerdicts(forkReply(outcome), sent.messages.map((m) => m.uid));
  if (!verdicts) throw new Error("the model's answer about your sent mail could not be read");
  await applySentVerdicts(account.id, sent, verdicts, ctx.state, now);
}

async function judgeAndPost(account: MailAccount, mail: NewMail, known: Set<string>, ctx: PassContext): Promise<number> {
  const { d, now } = ctx;
  const window = await (d.calendar ?? eventsBetween)(now, new Date(now.getTime() + CALENDAR_AHEAD_MS));
  const ratings = loadRatings();
  const messages = mail.messages.map((m) => ({ ...m, knownSender: known.has(addressOf(m.from)), rated: senderRecord(ratings, addressOf(m.from)) }));
  const forkSessionId = `${MAIL_WATCH_SESSION_PREFIX}${now.getTime()}-${account.id}`;
  const outcome = await (d.runFork ?? runReviewFork)({
    forkSessionId,
    message: buildMailWatchMessage({ now, messages, events: window.events, unreadableCalendars: window.unreadable.map((u) => u.label), ratingsNote: categoryRecord(ratings) }),
    systemPrompt: MAIL_WATCH_SYSTEM_PROMPT,
    section: { id: "mail-watch", label: "Mail Watch" },
    tools: [],
    opType: OP_TYPE.mailWatch,
    maxIterations: 2,
    timeoutMs: FORK_TIMEOUT_MS,
    ...(ctx.localOnly ? { localOnly: {} } : {}),
  }, d);
  const failure = reviewFailure(outcome);
  if (failure) throw new Error(`the mail check ${failure}`);
  const verdicts = parseMailVerdicts(forkReply(outcome), messages.map((m) => m.uid));
  if (!verdicts) throw new Error("the model's answer about your mail could not be read");

  const byUid = new Map(verdicts.map((v) => [v.uid, v]));
  let important = 0;
  const rest: EmailSummary[] = [];
  for (const m of mail.messages) {
    const v = byUid.get(m.uid);
    // Twice "not important" and never "useful": the user has said (a travel change still rings).
    if (!v?.important || (demoted(ratings, addressOf(m.from)) && v.category !== "travel")) { rest.push(m); continue; }
    if (v.category === "person" || v.category === "job") noteOwed(ctx.state, account.id, m, now);
    const id = m.messageId ?? `uid-${mail.checkpoint.uidValidity}-${m.uid}`;
    const posted = inboxImportantMail({
      account: account.id, id, from: m.from, subject: m.subject, why: v.why || "Looks important.", travel: v.category === "travel",
    });
    if (posted) { important++; noteAlert(mailAlertKey(account.id, id), addressOf(m.from), v.category, now.getTime()); }
    if (v.when) await notePlanFromMail(account.id, m.messageId ?? `uid-${m.uid}`, v.when, d);
  }
  queueForDigest(ctx.state, rest);
  return important;
}

/** A booking, flight or due time the mail sets becomes a plan, checked for
 *  clashes with the rest of the user's time (src/calendar/plans.ts). */
async function notePlanFromMail(accountId: string, messageId: string, when: NonNullable<MailVerdict["when"]>, d: MailWatchDeps): Promise<void> {
  const origin = { kind: "mail" as const, ref: `${accountId}:${messageId}` };
  try {
    const plan = { title: when.what, start: when.start, ...(when.end ? { end: when.end } : {}), ...(when.where ? { where: when.where } : {}), origin };
    const r = await recordPlan(plan, d.now ? { now: d.now } : {});
    if (r.recorded && r.clashes.length > 0) announceClash(plan, r.clashes, origin);
  } catch (e) {
    logger.warn(`[mail-watch] plan "${when.what}" not recorded: ${(e as Error).message}`);
  }
}

function queueForDigest(state: MailWatchState, messages: EmailSummary[]): void {
  for (const m of messages) state.digest.pending.push({ from: m.from, subject: m.subject, date: m.date });
}

function tellOnce(state: MailWatchState, day: string, text: string): void {
  if (state.lastProblemDay === day) return;
  if (inboxMailWatchProblem({ day, text })) state.lastProblemDay = day;
}

function noteFailure(e: Error, state: MailWatchState, day: string): void {
  logger.warn(`[mail-watch] pass failed (${state.failures} in a row): ${e.message}`);
  if (e instanceof LocalModelUnavailableError) {
    tellOnce(state, day, "You chose to have mail checked by a model on this computer only, and none is available. Start your local model, or let the chat model check it. Mail is kept until it can be checked.");
  } else if (state.failures >= FAILURES_BEFORE_NOTICE) {
    tellOnce(state, day, `The last ${state.failures} mail checks failed: ${e.message}`);
  }
}

/** Once a day, when quiet hours end (the user's morning), the mail that did
 *  not need them right away is posted as one item. */
export function postDigestIfDue(state: MailWatchState, now: Date, morning: string): void {
  const day = localDay(now);
  if (state.digest.lastPostedDay === day) return;
  if (state.digest.pending.length + state.digest.skipped === 0) return;
  const at = minutesOf(morning) ?? 7 * 60;
  if (now.getHours() * 60 + now.getMinutes() < at) return;
  if (inboxMailDigest({ day, entries: state.digest.pending, skipped: state.digest.skipped })) {
    state.digest = { pending: [], skipped: 0, lastPostedDay: day };
  }
}

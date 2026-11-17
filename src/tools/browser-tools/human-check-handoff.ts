/**
 * Handing a human check to the user and picking the task back up after.
 *
 * The agent never ticks an "I am human" box or solves a CAPTCHA: that check is
 * how a site tells a person from a bot (human-verification.ts). Before this the
 * agent stopped there and told the user to finish on the PC later, so a
 * purchase they had approved never went through (the Purell reorder,
 * 2026-11-17). Now, when a chat's browser shows a check:
 *
 *   1. the user is alerted where they are (their phone, with the page to tick
 *      it on; the browser on the PC shows it too);
 *   2. the page is watched until the check is gone;
 *   3. the chat gets a message from the app, so its agent carries on with what
 *      the user asked, without them having to say so.
 *
 * One handoff per chat at a time; it gives up after GIVE_UP_MS. An unattended
 * run (a scheduled job) is not handed off here: its block goes to the inbox.
 */
import { unlink } from "node:fs/promises";
import type { ToolResult } from "../../types.js";
import { getBrowserManager, withBrowserLock } from "../../browser/index.js";
import type { RelayedInput } from "../../browser/relayed-input.js";
import { HUMAN_VERIFICATION_MESSAGE, requiresHumanVerification, snapshotShowsHumanVerification } from "../../browser/human-verification.js";
import { isUserChat, sendAppMessageWhenIdle } from "../../chat-ws/app-message.js";
import { postToInbox, resolveInboxWhere } from "../../inbox/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("browser.human-check-handoff");

export const POLL_MS = 3_000;
export const GIVE_UP_MS = 10 * 60_000;

/** The inbox item a handoff posts and closes. */
export const humanCheckKey = (sessionId: string): string => `human-check:${sessionId}`;
/** The link the phone opens it by (agentxos-mobile resolveInboxLink). */
export const humanCheckLink = (sessionId: string): string => `/human-check/${encodeURIComponent(sessionId)}`;

/** How the user is alerted that `site` needs them: an inbox item that rings
 *  the phone (phone-push rings for "agent-message"), whose link opens the page
 *  on the phone to tick the box. Swapped in tests. */
export type HumanCheckAlert = (sessionId: string, site: string) => void;
const inboxAlert: HumanCheckAlert = (sessionId, site) => {
  postToInbox({
    kind: "agent-message",
    title: `${site} wants you to confirm you're human`,
    body: "Open this and do the check on the page: tick, hold, slide or type, whatever it asks. Your agent finishes what you asked as soon as you do.",
    needsYou: true,
    key: humanCheckKey(sessionId),
    link: { sessionId, url: humanCheckLink(sessionId) },
    ringThroughQuietHours: true,
  });
};
let alertUser: HumanCheckAlert | null = inboxAlert;
export function setHumanCheckAlert(fn: HumanCheckAlert | null): void { alertUser = fn; }

interface Handoff { site: string; startedAt: number; timer: ReturnType<typeof setInterval> | null; polling: boolean }
const live = new Map<string, Handoff>();
let now: () => number = Date.now;

function siteOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") || "the site"; } catch { return "the site"; }
}

/** Whether a browser result shows a human check: the gate's refusal, or a
 *  page snapshot carrying one. */
export function resultShowsHumanCheck(result: ToolResult): boolean {
  if (result.metadata?.browserStatus === "human-verification-required") return true;
  const text = typeof result.content === "string" ? result.content : "";
  return text.includes(HUMAN_VERIFICATION_MESSAGE) || snapshotShowsHumanVerification(text);
}

export function resumeMessage(site: string): string {
  return [
    `(Sent by the app, not typed by the user: the human check on ${site} is no longer on screen, so the user has dealt with it.)`,
    "Look at the browser page and carry on with what the user asked. Their earlier yes still stands for what they approved; " +
      "anything that needs a fresh yes still asks for one. If the check is back, say so in one line and stop.",
  ].join("\n");
}

function handoffNote(site: string, alerted: boolean): string {
  const where = alerted ? "Their phone has been sent an alert that opens this page so they can tick it there, and the" : "The";
  return `\n\nHANDED TO THE USER: ${where} browser on their PC shows it too. Tell them in one line that ${site} wants them to confirm they're human, ` +
    "and that you'll finish as soon as they do. Do not retry, poll or click anything on this page: the app tells you when the check is gone.";
}

function stop(sessionId: string): void {
  const h = live.get(sessionId);
  if (h?.timer) clearInterval(h.timer);
  live.delete(sessionId);
  if (!h) return;
  const key = humanCheckKey(sessionId);
  try { resolveInboxWhere((item) => item.key === key); } catch (e) { logger.debug(`closing the inbox item failed: ${(e as Error).message}`); }
}

async function poll(sessionId: string): Promise<void> {
  const h = live.get(sessionId);
  if (!h || h.polling) return;
  if (now() - h.startedAt > GIVE_UP_MS) { logger.info(`gave up waiting on ${h.site} for ${sessionId}`); stop(sessionId); return; }
  h.polling = true;
  try {
    const manager = getBrowserManager(sessionId);
    const open = await withBrowserLock(sessionId, async () => requiresHumanVerification(await manager.observe()));
    if (open || live.get(sessionId) !== h) return;
    stop(sessionId);
    logger.info(`check on ${h.site} cleared for ${sessionId}; resuming the chat`);
    sendAppMessageWhenIdle(sessionId, () => resumeMessage(h.site));
  } catch (e) {
    logger.debug(`poll for ${sessionId} failed, will retry: ${(e as Error).message}`);
  } finally {
    h.polling = false;
  }
}

/**
 * A browser result in `sessionId` shows a human check: hand it to the user
 * (once per chat while one is open) and say so in the result the agent reads.
 * Returns the result unchanged when it shows no check or nobody is there to
 * hand it to.
 */
export function handOffHumanCheck(result: ToolResult, sessionId: string, pageUrl: string, unattended: boolean): ToolResult {
  if (unattended || !isUserChat(sessionId) || !resultShowsHumanCheck(result)) return result;
  const site = siteOf(pageUrl);
  let alerted = alertUser !== null;
  if (!live.has(sessionId)) {
    const h: Handoff = { site, startedAt: now(), timer: null, polling: false };
    live.set(sessionId, h);
    h.timer = setInterval(() => { void poll(sessionId); }, POLL_MS);
    h.timer.unref?.();
    try { alertUser?.(sessionId, site); } catch (e) { alerted = false; logger.warn(`alerting the user failed: ${(e as Error).message}`); }
    logger.info(`handed the check on ${site} to the user of ${sessionId}`);
  }
  const note = handoffNote(site, alerted);
  const content = `${typeof result.content === "string" ? result.content : ""}${note}`;
  // The refusal's own next step ("ask them, then retry here") is replaced:
  // retrying is the app's job now.
  const metadata = result.status === "blocked" ? { ...result.metadata, recovery: note.trim() } : result.metadata;
  return { ...result, content, metadata } as ToolResult;
}

/** What the phone shows while a check is handed to the user: the page as it
 *  is now, or `open: false` once there is nothing to do. Only a chat with a
 *  handoff open answers with a picture, so this never shows a browser the user
 *  did not just get an alert about. */
export async function humanCheckPicture(sessionId: string): Promise<{ open: false } | { open: true; site: string; mime: string; b64: string }> {
  const h = live.get(sessionId);
  if (!h) return { open: false };
  const shot = await withBrowserLock(sessionId, () => getBrowserManager(sessionId).screenshot());
  // A capture saves the full PNG for the agent's view_image; this one is only
  // for the phone, so it is not kept.
  if (shot.image?.path) await unlink(shot.image.path).catch(() => { /* already gone: nothing to tidy */ });
  if (!shot.image) throw new Error(shot.text.split("\n")[0] || "The page could not be captured.");
  return { open: true, site: h.site, mime: shot.image.mime, b64: shot.image.b64 };
}

/** A press the phone never released (the app closed, the network dropped)
 *  is let go after this long, so the page is not left with its button held. */
export const HELD_TOO_LONG_MS = 20_000;
const heldSince = new Map<string, { timer: ReturnType<typeof setTimeout>; x: number; y: number }>();

function trackHold(sessionId: string, input: RelayedInput): void {
  const held = heldSince.get(sessionId);
  if (input.kind === "press") {
    if (held) clearTimeout(held.timer);
    const timer = setTimeout(() => {
      heldSince.delete(sessionId);
      void withBrowserLock(sessionId, () => getBrowserManager(sessionId).relayInput({ kind: "release", x: input.x, y: input.y }))
        .catch((e) => logger.debug(`letting go of a stale press failed: ${(e as Error).message}`));
    }, HELD_TOO_LONG_MS);
    timer.unref?.();
    heldSince.set(sessionId, { timer, x: input.x, y: input.y });
  } else if (held && (input.kind === "release" || input.kind === "tap")) {
    clearTimeout(held.timer);
    heldSince.delete(sessionId);
  }
}

/** The user's input on that picture: a tap, the steps of a drag or a hold
 *  (press, move, release), or typing (relayed-input.ts). Refused unless a
 *  handoff is open for the chat. The page is checked again a second after a
 *  tap, a release or a key, so the chat resumes as soon as the check is done. */
export async function relayHumanCheck(sessionId: string, input: RelayedInput): Promise<boolean> {
  if (!live.has(sessionId)) return false;
  await withBrowserLock(sessionId, () => getBrowserManager(sessionId).relayInput(input));
  trackHold(sessionId, input);
  if (input.kind !== "press" && input.kind !== "move") setTimeout(() => { void poll(sessionId); }, 1_000).unref?.();
  return true;
}

/** Test seams. */
export async function _pollHumanCheckForTest(sessionId: string): Promise<void> { await poll(sessionId); }
export function _setHumanCheckClockForTest(clock: (() => number) | null): void { now = clock ?? Date.now; }
export function _resetHumanCheckHandoffForTest(): void {
  for (const id of [...live.keys()]) stop(id);
  for (const held of heldSince.values()) clearTimeout(held.timer);
  heldSince.clear();
  alertUser = inboxAlert; now = Date.now;
}

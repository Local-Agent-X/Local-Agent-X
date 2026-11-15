// phone-push/ — rings the paired phone like a text when the inbox gets an item
// the user chose to hear about, even with the app closed. See AGENTS.md here.
//
// The phone registers over the chat socket (`push_register`: its Expo push
// token, a key it generated, the kinds it wants); every new inbox item
// (`inbox:posted`) of a wanted kind is sealed with that phone's key and handed
// to Expo's push service. Expo and Google carry ciphertext only.

import { join } from "node:path";
import type { WebSocket } from "ws";
import { EventBus } from "../event-bus.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getOrCreateMasterKey } from "../keychain.js";
import { isLocalOnlyMode } from "../local-only-policy.js";
import { createLogger } from "../logger.js";
import { sendFrame } from "../chat-ws/frames.js";
import {
  parsePushRegister,
  parsePushUnregister,
  pushAlertOf,
  type PushRegisteredFrame,
} from "../broker-transport/vendor/protocol.js";
import type { InboxItem } from "../inbox/types.js";
import { createPhonePushStore, type PhonePushStore } from "./store.js";
import { sealPushAlert } from "./seal.js";
import { expoPushMessage, isDeadToken, sendExpoPush } from "./send.js";
import { getRuntimeConfig } from "../config.js";
import { heldAlerts, quietUntil, type HeldAlerts } from "./quiet-hours.js";

const logger = createLogger("phone-push");

let cached: { path: string; store: PhonePushStore } | null = null;

/** The process's store at <lax data dir>/phone-push.json. */
export function phonePushStore(): PhonePushStore {
  const dir = getLaxDir();
  const path = join(dir, "phone-push.json");
  if (!cached || cached.path !== path) {
    const onUnreadable = (token: string) => logger.warn(`[phone-push] ${shortToken(token)}: key no longer opens; skipped until the phone registers again`);
    cached = { path, store: createPhonePushStore(path, () => getOrCreateMasterKey(dir).key, onUnreadable) };
  }
  return cached.store;
}

/** Enough of a token to tell phones apart in a log, never the whole of it. */
function shortToken(token: string): string {
  return `${token.slice(0, 22)}…`;
}

/** True when the frame was a push frame (answered or refused on `ws`). */
export function handlePushFrame(ws: Pick<WebSocket, "send" | "readyState">, msg: Record<string, unknown>, store: PhonePushStore = phonePushStore()): boolean {
  if (msg.type !== "push_register" && msg.type !== "push_unregister") return false;
  const reply = (frame: PushRegisteredFrame) => { if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(frame)); };
  const register = parsePushRegister(msg);
  if (register) {
    store.register({ token: register.token, key: register.key, kinds: register.kinds, ...(register.device ? { device: register.device } : {}) });
    logger.info(`[phone-push] ${register.device ?? "a phone"} registered (${shortToken(register.token)}) for ${register.kinds.join(", ") || "nothing"}`);
    reply({ type: "push_registered", token: register.token, kinds: register.kinds });
    return true;
  }
  const unregister = parsePushUnregister(msg);
  if (unregister) {
    store.unregister(unregister.token);
    reply({ type: "push_registered", token: unregister.token, kinds: [] });
    return true;
  }
  sendFrame(ws, { type: "error", message: `${String(msg.type)} needs an Expo push token${msg.type === "push_register" ? ", a 32-byte base64 key and a kinds list" : ""}` });
  return true;
}

export interface AlertDeps {
  store: PhonePushStore;
  send: typeof sendExpoPush;
  localOnly: () => boolean;
  /** When the current quiet hours end, or null outside them. */
  quietUntil: () => Date | null;
  held: HeldAlerts;
  /** Arms the release of held alerts at `at`. */
  scheduleRelease: (at: Date) => void;
}

const defaultDeps = (): AlertDeps => ({
  store: phonePushStore(),
  send: sendExpoPush,
  localOnly: () => isLocalOnlyMode(),
  quietUntil: () => quietUntil(new Date(), getRuntimeConfig()),
  held: heldAlerts(),
  scheduleRelease,
});

/** Alert every phone that wants this item's kind, now or, inside quiet hours,
 *  when they end (`ringThroughQuietHours`: a travel change rings anyway).
 *  Never throws: it runs off an inbox post, and a failed alert must not touch
 *  the inbox. */
export async function alertPhones(
  item: InboxItem,
  deps: AlertDeps = defaultDeps(),
  opts: { ringThroughQuietHours?: boolean } = {},
): Promise<void> {
  try {
    if (deps.localOnly()) return;
    if (!deps.store.list().some((p) => p.kinds.includes(item.kind))) return;
    const until = opts.ringThroughQuietHours ? null : deps.quietUntil();
    if (until) {
      deps.held.add(item);
      deps.scheduleRelease(until);
      return;
    }
    await sendAlert(item, deps);
  } catch (e) {
    logger.warn(`[phone-push] alert for inbox item ${item.id} not sent: ${(e as Error).message}`);
  }
}

async function sendAlert(item: InboxItem, deps: AlertDeps): Promise<void> {
  const phones = deps.store.list().filter((p) => p.kinds.includes(item.kind));
  if (phones.length === 0) return;
  const alert = pushAlertOf(item);
  const tickets = await deps.send(phones.map((p) => expoPushMessage(p.token, sealPushAlert(alert, p.key))));
  tickets.forEach((ticket, i) => {
    const phone = phones[i];
    if (!phone || ticket.status === "ok") return;
    logger.warn(`[phone-push] ${shortToken(phone.token)}: ${ticket.message}`);
    if (isDeadToken(ticket)) deps.store.unregister(phone.token);
  });
}

/** Send what quiet hours held, unless quiet hours (changed since) still hold
 *  them, in which case wait for their new end. Never throws. */
export async function releaseHeldAlerts(deps: AlertDeps = defaultDeps()): Promise<number> {
  try {
    const until = deps.quietUntil();
    if (until) {
      if (deps.held.list().length > 0) deps.scheduleRelease(until);
      return 0;
    }
    const items = deps.localOnly() ? [] : deps.held.take();
    for (const item of items) await sendAlert(item, deps);
    if (items.length > 0) logger.info(`[phone-push] quiet hours over: sent ${items.length} held alert(s)`);
    return items.length;
  } catch (e) {
    logger.warn(`[phone-push] held alerts not sent: ${(e as Error).message}`);
    return 0;
  }
}

let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** One timer for the end of quiet hours; a later call replaces it. */
function scheduleRelease(at: Date): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  const delay = Math.max(1_000, at.getTime() - Date.now() + 1_000);
  releaseTimer = setTimeout(() => { releaseTimer = null; void releaseHeldAlerts(); }, delay);
  releaseTimer.unref?.();
}

let started = false;

/** Listen for new inbox items, and deliver anything a restart left held.
 *  Called once at boot. */
export function startPhonePush(): void {
  if (started) return;
  started = true;
  EventBus.on("inbox:posted", ({ item, ringThroughQuietHours }) => alertPhones(item, defaultDeps(), { ringThroughQuietHours }));
  if (heldAlerts().list().length > 0) void releaseHeldAlerts();
}

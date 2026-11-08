// Phone alerts: a push notification that rings the phone like a text when the desktop's
// inbox gets an item the user chose to hear about, even with the app closed. The only way
// to wake a closed Android app is Google's push service, so the alert travels desktop →
// Expo's push service → Google → phone. What it says must not: the phone makes a random
// key, hands it to the desktop over the peer link (the broker never sees it), and the
// desktop seals each alert with it. Expo and Google carry `SealedPushData` only, and the
// phone opens it on the device before showing anything.
//
// Sealing: AES-256-GCM, a fresh 12-byte nonce per alert, PUSH_AAD as the associated data,
// the 16-byte tag appended to the ciphertext (the layout both Node's crypto and
// @noble/ciphers use). Keys, nonces and ciphertext travel as standard base64.

import { asRecord, asString } from "./guards.js";
import { INBOX_ITEM_KINDS, type InboxItem, type InboxItemKind } from "./inbox.js";

/** What a phone alerts on until the user changes it in the app: the agent writing to
 *  them, and a call waiting for their yes. */
export const PUSH_DEFAULT_KINDS: readonly InboxItemKind[] = ["agent-message", "approval"];

export const PUSH_KEY_BYTES = 32;
export const PUSH_NONCE_BYTES = 12;
/** Binds a sealed alert to this format: one sealed for another use does not open. */
export const PUSH_AAD = "agentxos-push-v1";

/** The longest title and body an alert carries (a push payload is capped at 4 KB). */
export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 240;

// ── phone → desktop ──

/** Alert this phone. `token` is its Expo push token; `key` the base64 AES-256 key the
 *  desktop seals its alerts with; `kinds` the inbox kinds it wants. Sent again whenever
 *  any of them changes; the desktop keeps one registration per token. */
export type PushRegisterFrame = { type: "push_register"; token: string; key: string; kinds: InboxItemKind[]; device?: string };

/** Stop alerting this phone (the user turned alerts off or unpaired). */
export type PushUnregisterFrame = { type: "push_unregister"; token: string };

export type PushOutboundFrame = PushRegisterFrame | PushUnregisterFrame;

// ── desktop → phone ──

/** The registration as the desktop now holds it: `kinds` empty after an unregister. */
export type PushRegisteredFrame = { type: "push_registered"; token: string; kinds: InboxItemKind[] };

// ── the push itself (desktop → Expo → Google → phone) ──

/** The push's `data`: everything Expo and Google see of an alert. */
export type SealedPushData = { v: 1; n: string; c: string };

/** What a sealed alert holds once the phone opens it. */
export type PushAlert = { id: string; kind: InboxItemKind; title: string; body: string };

// ── builders and parsers ──

const EXPO_TOKEN = /^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]+\]$/;
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The alert for an inbox item, clipped to fit a push. */
export function pushAlertOf(item: Pick<InboxItem, "id" | "kind" | "title" | "body">): PushAlert {
  return { id: item.id, kind: item.kind, title: clip(item.title, PUSH_TITLE_MAX), body: clip(item.body, PUSH_BODY_MAX) };
}

function parseKinds(raw: unknown): InboxItemKind[] | null {
  if (!Array.isArray(raw)) return null;
  return INBOX_ITEM_KINDS.filter((kind) => raw.includes(kind));
}

/** A `push_register` frame, or null for any other frame or a malformed one (a token that
 *  is not an Expo push token, a key that is not 32 bytes of base64). */
export function parsePushRegister(raw: unknown): PushRegisterFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "push_register") return null;
  const token = asString(msg.token);
  const key = asString(msg.key);
  const kinds = parseKinds(msg.kinds);
  if (token === null || !EXPO_TOKEN.test(token) || key === null || !KEY_B64.test(key) || kinds === null) return null;
  const frame: PushRegisterFrame = { type: "push_register", token, key, kinds };
  const device = asString(msg.device);
  if (device) frame.device = device.slice(0, 80);
  return frame;
}

export function parsePushUnregister(raw: unknown): PushUnregisterFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "push_unregister") return null;
  const token = asString(msg.token);
  return token !== null && EXPO_TOKEN.test(token) ? { type: "push_unregister", token } : null;
}

export function parsePushRegistered(raw: unknown): PushRegisteredFrame | null {
  const msg = asRecord(raw);
  if (msg === null || msg.type !== "push_registered") return null;
  const token = asString(msg.token);
  const kinds = parseKinds(msg.kinds);
  return token !== null && kinds !== null ? { type: "push_registered", token, kinds } : null;
}

/** A push's sealed data, or null when it is not one this build can open. */
export function parseSealedPushData(raw: unknown): SealedPushData | null {
  const rec = asRecord(raw);
  if (rec === null || rec.v !== 1) return null;
  const n = asString(rec.n);
  const c = asString(rec.c);
  if (n === null || c === null || !B64.test(n) || !B64.test(c)) return null;
  return { v: 1, n, c };
}

/** An opened alert's JSON, or null when it is malformed. */
export function parsePushAlert(raw: unknown): PushAlert | null {
  const rec = asRecord(raw);
  if (rec === null) return null;
  const id = asString(rec.id);
  const title = asString(rec.title);
  if (id === null || title === null) return null;
  const kind = typeof rec.kind === "string" && (INBOX_ITEM_KINDS as readonly string[]).includes(rec.kind) ? (rec.kind as InboxItemKind) : "notice";
  return { id, kind, title, body: asString(rec.body) ?? "" };
}

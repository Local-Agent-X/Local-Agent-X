// Hands sealed alerts to Expo's push service, which delivers them through
// Google's (Android) or Apple's push. Each message carries data only: no title
// or body Expo or Google could read, so the phone wakes, opens the sealed data
// itself and shows the notification.

import type { SealedPushData } from "../broker-transport/vendor/protocol.js";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** An alert older than a day is stale news: drop it rather than deliver late. */
const ALERT_TTL_SECONDS = 24 * 60 * 60;

export interface ExpoPushMessage {
  to: string;
  data: SealedPushData;
  priority: "high";
  ttl: number;
}

/** Expo's answer per message, in the order sent. */
export type PushTicket =
  | { status: "ok" }
  | { status: "error"; message: string; error?: string };

export function expoPushMessage(token: string, data: SealedPushData): ExpoPushMessage {
  return { to: token, data, priority: "high", ttl: ALERT_TTL_SECONDS };
}

/** True when Expo says the token is dead: the app was uninstalled or its
 *  token rotated, so the registration should go. */
export function isDeadToken(ticket: PushTicket): boolean {
  return ticket.status === "error" && ticket.error === "DeviceNotRegistered";
}

export async function sendExpoPush(messages: ExpoPushMessage[], fetchImpl: typeof fetch = fetch): Promise<PushTicket[]> {
  const res = await fetchImpl(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Expo push answered ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  if (!Array.isArray(json.data)) throw new Error("Expo push answered without tickets");
  return json.data.map((raw): PushTicket => {
    const t = raw as { status?: unknown; message?: unknown; details?: { error?: unknown } };
    if (t.status === "ok") return { status: "ok" };
    const error = typeof t.details?.error === "string" ? t.details.error : undefined;
    return { status: "error", message: typeof t.message === "string" ? t.message : "unknown error", ...(error ? { error } : {}) };
  });
}

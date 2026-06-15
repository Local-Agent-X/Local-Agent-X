// Restart/relaunch "ping me when you're back" rail.
//
// A process can't message you AFTER it restarts itself — the messenger dies in
// the restart. So we persist a tiny marker before going down; the NEW server,
// once its bridges reconnect, reads the marker, pings the requester, and clears
// it. The ping is sent by the new process, so it survives the restart.
//
// Failure (basic): the marker carries a deadline. If the new server boots after
// the deadline (it took too long, or a prior attempt failed and this is a later
// recovery boot), the ping says so instead of a clean "back up". If NO server
// ever boots (a broken build), there's no ping — but the desktop crash-loop
// breaker surfaces the recovery screen, and the sandbox gate makes that rare.

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { getLaxDir } from "./lax-data-dir.js";
import { createLogger } from "./logger.js";
import { formatForChannel } from "./channel-formatter.js";
import { getTelegramBridgeInstance } from "./telegram-bridge/index.js";
import { getWhatsAppBridgeInstance } from "./whatsapp-bridge/index.js";

const logger = createLogger("restart-notify");

export type NotifyChannel = "telegram" | "whatsapp";

export interface RestartNotice {
  channel: NotifyChannel;
  target: string;       // telegram chatId or whatsapp phone
  reason: string;       // "pick up new code", "update to abc1234", …
  requestedAt: number;  // ms epoch
  deadlineMs: number;   // requestedAt + budget; boots past this report as slow/recovered
}

function markerPath(): string { return join(getLaxDir(), "restart-notify.json"); }

export function writeRestartNotice(n: RestartNotice): void {
  try { writeFileSync(markerPath(), JSON.stringify(n), "utf-8"); }
  catch (e) { logger.warn(`[restart-notify] could not write marker: ${(e as Error).message}`); }
}

export function readRestartNotice(): RestartNotice | null {
  try {
    const p = markerPath();
    if (!existsSync(p)) return null;
    const n = JSON.parse(readFileSync(p, "utf-8")) as RestartNotice;
    if (!n || (n.channel !== "telegram" && n.channel !== "whatsapp") || !n.target) return null;
    return n;
  } catch { return null; }
}

export function clearRestartNotice(): void {
  try { const p = markerPath(); if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
}

/** Pure message builder (testable without a live bridge). */
export function buildRestartPingMessage(n: RestartNotice, now: number): string {
  const tookS = Math.max(0, Math.round((now - n.requestedAt) / 1000));
  if (now > n.deadlineMs) {
    return `⚠️ Back up now — ${n.reason}. That took ${tookS}s, longer than expected (an earlier restart may have failed and just recovered). If anything looks off, check the app.`;
  }
  return `✅ Back up — ${n.reason}. (${tookS}s)`;
}

/**
 * Resolve who to ping back. Prefer the channel the request came in on (derived
 * from the session id: tg-<chatId> / wa-<phone>). For a web/in-app request,
 * fall back to the configured owner on a connected bridge (Telegram first).
 */
export async function resolveNotifyTarget(
  args: Record<string, unknown>,
): Promise<{ channel: NotifyChannel; target: string } | null> {
  const sid = typeof args._sessionId === "string" ? args._sessionId : "";
  if (sid.startsWith("tg-")) return { channel: "telegram", target: sid.slice(3) };
  if (sid.startsWith("wa-")) return { channel: "whatsapp", target: sid.slice(3) };

  const tg = getTelegramBridgeInstance();
  const tgStatus = tg?.getStatus();
  if (tgStatus?.state === "connected" && tgStatus.allowedChatIds[0]) {
    return { channel: "telegram", target: tgStatus.allowedChatIds[0] };
  }
  const wa = getWhatsAppBridgeInstance();
  if (wa) {
    const st = await wa.getStatus();
    if (st.state === "connected" && st.phone) return { channel: "whatsapp", target: st.phone };
  }
  return null;
}

/**
 * Called when a bridge finishes (re)connecting on boot. If a restart was
 * requested on THIS channel, send the "back up" ping and clear the marker.
 * Tying it to the connect event guarantees the bridge is live when we send.
 */
export async function sendRestartPingIfPending(connectedChannel: NotifyChannel): Promise<void> {
  const n = readRestartNotice();
  if (!n || n.channel !== connectedChannel) return;

  const msg = buildRestartPingMessage(n, Date.now());
  try {
    if (n.channel === "telegram") {
      const b = getTelegramBridgeInstance();
      if (b?.getStatus().state === "connected") {
        await b.sendMessage(n.target, formatForChannel(msg, "telegram").join("\n\n"));
      }
    } else {
      const b = getWhatsAppBridgeInstance();
      const st = b ? await b.getStatus() : null;
      if (b && st?.state === "connected") {
        await b.sendMessage(n.target, formatForChannel(msg, "whatsapp").join("\n\n"));
      }
    }
    clearRestartNotice();
  } catch (e) {
    // Leave the marker so a later connect/boot can retry the ping.
    logger.warn(`[restart-notify] ping on ${connectedChannel} failed: ${(e as Error).message}`);
  }
}

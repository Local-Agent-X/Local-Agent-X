// Allowed-chats persistence + owner-claim window. Telegram default-denies:
// only chat IDs in the allowlist can message the agent. The list lives in
// ~/.lax/telegram-config.json.
//
// Unlike WhatsApp — where QR pairing proves ownership, so the linked account
// IS the owner — a bot token carries no identity. Anyone who learns the bot's
// handle can message it. So ownership is claimed explicitly: the operator
// opens a short window from the UI, and the next inbound message during that
// window locks the bot. The window lives in memory only and is deliberately
// NOT persisted; a window that survived a restart would re-open the
// unattended-claim race it exists to close.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../logger.js";
import { messagingChannelConfigPath } from "../session/channel-registry.js";

const logger = createLogger("telegram-bridge");

export const CLAIM_WINDOW_MS = 120_000;

function configPath(dataDir: string): string {
  return messagingChannelConfigPath(dataDir, "telegram");
}

export function loadAllowedChats(dataDir: string): Set<string> {
  try {
    const p = configPath(dataDir);
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"));
      if (Array.isArray(cfg.allowedChatIds)) {
        return sanitizeChatIds(cfg.allowedChatIds.map(String));
      }
    }
  } catch (e) {
    logger.error("[telegram] Failed to load telegram-config.json:", (e as Error).message);
  }
  return new Set();
}

export function saveAllowedChats(dataDir: string, ids: Set<string>): void {
  try {
    writeFileSync(configPath(dataDir), JSON.stringify({ allowedChatIds: [...ids] }, null, 2));
  } catch (e) {
    logger.error("[telegram] Failed to save config:", (e as Error).message);
  }
}

/** Sanitize + filter chat IDs. Telegram IDs are signed 64-bit integers —
 *  positive for users, negative for groups and supergroups. Rejects anything
 *  that isn't a plausible integer so a typo can't silently widen the
 *  allowlist to an unusable value. */
export function sanitizeChatIds(ids: string[]): Set<string> {
  return new Set(
    ids
      .map(id => String(id).trim())
      .filter(id => /^-?[1-9]\d{0,18}$/.test(id)),
  );
}

/** Milliseconds left on a claim window, 0 when closed or expired. */
export function claimWindowRemainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now);
}

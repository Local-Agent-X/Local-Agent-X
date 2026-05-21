// Allowed-numbers persistence. WhatsApp default-denies: only the owner
// and explicitly allowed phone numbers can message the agent. The list
// lives in ~/.lax/whatsapp-config.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const logger = createLogger("whatsapp-bridge");

function configPath(dataDir: string): string {
  return join(dataDir, "whatsapp-config.json");
}

export function loadAllowedNumbers(dataDir: string): Set<string> {
  try {
    const p = configPath(dataDir);
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8"));
      if (Array.isArray(cfg.allowedNumbers)) {
        return new Set(cfg.allowedNumbers);
      }
    }
  } catch {}
  return new Set();
}

export function saveAllowedNumbers(dataDir: string, numbers: Set<string>): void {
  try {
    const cfg = { allowedNumbers: [...numbers] };
    writeFileSync(configPath(dataDir), JSON.stringify(cfg, null, 2));
  } catch (e) {
    logger.error("[whatsapp] Failed to save config:", (e as Error).message);
  }
}

/** Sanitize + filter a list of phone numbers. Strips non-digits and
 *  rejects entries outside 7-15 digits (E.164 plausibility check). */
export function sanitizeNumbers(numbers: string[]): Set<string> {
  return new Set(
    numbers.map(n => n.replace(/\D/g, "")).filter(n => n.length >= 7 && n.length <= 15),
  );
}

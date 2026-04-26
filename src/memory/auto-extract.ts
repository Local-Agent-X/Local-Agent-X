import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "./index-core.js";
import { atomicWriteFileSync, STOP_WORDS } from "./utils.js";

import { createLogger } from "../logger.js";
const logger = createLogger("memory.auto-extract");

export async function autoExtractAndSave(
  memory: MemoryIndex,
  userMessage: string,
  assistantResponse: string
): Promise<void> {
  try {
    const sanitize = await import("../sanitize.js");
    const taint = sanitize.checkMemoryTaint(userMessage);
    if (!taint.safe) {
      logger.info(`[memory] Auto-extract skipped: ${taint.reason}`);
      return;
    }
    const taintReply = sanitize.checkMemoryTaint(assistantResponse);
    if (!taintReply.safe) {
      logger.info(`[memory] Auto-extract skipped (assistant): ${taintReply.reason}`);
      return;
    }
  } catch {
  }

  const lower = userMessage.toLowerCase().trim();

  const renamePatterns = [
    /(?:your name is|call yourself|you are|i'?ll call you|name you|be called)\s+["']?([A-Z][a-zA-Z0-9_ -]{0,20})["']?/i,
    /^([A-Z][a-zA-Z]{1,15})(?:\.|!|\s*$)/,
  ];

  for (const pattern of renamePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      const newName = match[1].trim();
      if (newName.length >= 2 && newName.length <= 20) {
        const identityPath = join(memory["memoryDir"], "IDENTITY.md");
        if (existsSync(identityPath)) {
          let content = readFileSync(identityPath, "utf-8");
          content = content.replace(
            /^- Name:.*$/m,
            `- Name: ${newName}`
          );
          atomicWriteFileSync(identityPath, content);
          memory.markDirty();
          logger.info(`[memory] Auto-updated agent name to: ${newName}`);
        }
        memory.appendDailyLog(`Agent renamed to "${newName}" by user`);
        break;
      }
    }
  }

  const userNamePatterns = [
    /(?:my name is|i'?m|call me|i go by|people call me)\s+["']?([A-Z][a-zA-Z]{1,20})["']?/i,
  ];

  for (const pattern of userNamePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      const userName = match[1].trim();
      if (userName.length >= 2 && !STOP_WORDS.has(userName.toLowerCase())) {
        const userPath = join(memory["memoryDir"], "USER.md");
        if (existsSync(userPath)) {
          let content = readFileSync(userPath, "utf-8");
          if (content.includes("- Name:")) {
            content = content.replace(
              /^- Name:.*$/m,
              `- Name: ${userName}`
            );
          } else {
            content += `\n- Name: ${userName}`;
          }
          atomicWriteFileSync(userPath, content);
          memory.markDirty();
          logger.info(`[memory] Auto-saved user name: ${userName}`);
        }
        memory.appendDailyLog(`User introduced themselves as "${userName}"`);
        break;
      }
    }
  }

  const factPatterns: Array<{ pattern: RegExp; section: string }> = [
    { pattern: /i have (\d+) (?:kids?|children|sons?|daughters?)/i, section: "Family & People" },
    { pattern: /i(?:'m| am) (?:a |an )?(\w+ (?:developer|engineer|designer|manager|doctor|teacher|student|nurse|lawyer|chef|artist|writer|scientist|consultant|architect|analyst|director|founder|ceo|cto))/i, section: "About Me" },
    { pattern: /i (?:live|moved|relocated) (?:in|to) ([A-Z][a-zA-Z\s,]+)/i, section: "About Me" },
    { pattern: /i (?:work|am working) (?:at|for) ([A-Z][a-zA-Z\s&]+)/i, section: "About Me" },
  ];

  for (const { pattern } of factPatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      memory.appendDailyLog(`User shared: "${userMessage.slice(0, 200)}"`);
      break;
    }
  }
}

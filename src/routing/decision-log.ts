/**
 * Decision log — persistent + in-memory cache for every routing decision.
 *
 * Every routeMessage() call appends one entry to
 *   ~/.lax/auto-delegate-decisions.jsonl
 * AND to the in-memory cache (DECISION_LOG_CAP capped). The disk file
 * survives restarts; the in-memory cache makes /api/auto-delegate/recent
 * fast.
 *
 * `opId` is set later (after delegateMessageToWorker returns) for
 * delegated decisions so the UI's "Stay inline" override can find the
 * entry and mark userOverride=true. The corrective tag is the actual
 * training signal — these are the exact messages where the classifier
 * was wrong from the user's POV.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";
import type { AutoDelegateLogEntry } from "./types.js";

const logger = createLogger("routing.decision-log");

const DECISION_LOG_CAP = 1000;
const decisionLog: AutoDelegateLogEntry[] = [];
let logFilePath: string | null = null;
let logLoaded = false;

function getLogFilePath(): string {
  if (logFilePath) return logFilePath;
  const dir = process.env.LAX_DATA_DIR || join(homedir(), ".lax");
  logFilePath = join(dir, "auto-delegate-decisions.jsonl");
  return logFilePath;
}

function loadLogFromDisk(): void {
  if (logLoaded) return;
  logLoaded = true;
  try {
    const p = getLogFilePath();
    if (!existsSync(p)) return;
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-DECISION_LOG_CAP);
    for (const line of tail) {
      try { decisionLog.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  } catch (e) {
    logger.warn(`log restore failed: ${(e as Error).message}`);
  }
}

function appendDecisionToDisk(entry: AutoDelegateLogEntry): void {
  try {
    const p = getLogFilePath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
    // Rotate when file grows past ~1MB. Keep last DECISION_LOG_CAP lines.
    const stat = statSync(p);
    if (stat.size > 1_000_000) {
      const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
      if (lines.length > DECISION_LOG_CAP) {
        writeFileSync(p, lines.slice(-DECISION_LOG_CAP).join("\n") + "\n", "utf-8");
      }
    }
  } catch (e) {
    logger.warn(`log append failed: ${(e as Error).message}`);
  }
}

export function recordDecision(entry: AutoDelegateLogEntry): void {
  loadLogFromDisk();
  decisionLog.push(entry);
  if (decisionLog.length > DECISION_LOG_CAP) {
    decisionLog.splice(0, decisionLog.length - DECISION_LOG_CAP);
  }
  appendDecisionToDisk(entry);
}

export function getRecentAutoDelegateDecisions(limit = 50): AutoDelegateLogEntry[] {
  loadLogFromDisk();
  return decisionLog.slice(-Math.max(1, Math.min(limit, DECISION_LOG_CAP)));
}

function messagePreviewOf(message: string): string {
  return `${message.slice(0, 80).replace(/\s+/g, " ")}${message.length > 80 ? "…" : ""}`;
}

/**
 * Called by chat.ts AFTER delegateMessageToWorker returns the opId — links
 * the decision back to the spawned op so the "Stay inline" UI can find it.
 * We assume the most recent DELEGATE decision matching this message is the
 * one being linked (called within microseconds of the route call).
 */
export function linkDecisionToOpId(opId: string, message: string): void {
  const preview = messagePreviewOf(message);
  for (let i = decisionLog.length - 1; i >= 0; i--) {
    const e = decisionLog[i];
    if (e.delegate && !e.opId && e.messagePreview === preview) {
      e.opId = opId;
      e.message = message;
      appendDecisionToDisk(e);
      return;
    }
  }
}

/**
 * Called by /api/auto-delegate/override when user clicks "Stay inline" on
 * a spawned worker card. Marks the decision as a user-override (training
 * signal: this is what the classifier got wrong) and returns the original
 * message so the chat can re-submit it with /discuss prepended.
 */
export function markDecisionAsUserOverride(opId: string): { message: string | null } {
  for (let i = decisionLog.length - 1; i >= 0; i--) {
    const e = decisionLog[i];
    if (e.opId === opId) {
      e.userOverride = true;
      appendDecisionToDisk(e);
      return { message: e.message || null };
    }
  }
  return { message: null };
}

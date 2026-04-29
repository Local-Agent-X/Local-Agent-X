/**
 * Durable per-op event log.
 *
 * Each op's events are appended to ~/.lax/operations/<opId>/events.jsonl.
 * Events are redacted (by redactor.ts) before disk-write — the original
 * un-redacted event still streams to live UI subscribers via WS, but only
 * the safe form is persisted.
 *
 * Append-only by design. If the UI reloads, it can replay from disk to
 * reconstruct the visible op state. If the worker crashes, the supervisor
 * reads this log to know what was already done — but for actual resume
 * state, it reads checkpoint.json (see checkpoint.ts).
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { redactEventForDisk } from "./redactor.js";
import type { OpEvent } from "./types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("workers.event-log");

const OPS_BASE = join(homedir(), ".lax", "operations");

/** Resolve the on-disk dir for an op. Creates if missing. */
export function opDir(opId: string): string {
  const dir = join(OPS_BASE, opId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Append a single event to the op's events.jsonl, after running it
 * through the redactor. Synchronous to preserve ordering across rapid
 * worker output (a queued async write can reorder under load).
 */
export function appendEvent(event: OpEvent): void {
  try {
    const dir = opDir(event.opId);
    const safe = redactEventForDisk(event);
    const line = JSON.stringify(safe) + "\n";
    appendFileSync(join(dir, "events.jsonl"), line, { encoding: "utf-8", mode: 0o600 });
  } catch (e) {
    // Disk write failure shouldn't crash the worker — log and continue.
    // The live WS stream still got the original event.
    logger.warn(`[event-log] failed to persist event for ${event.opId}: ${(e as Error).message}`);
  }
}

/**
 * Read all events for an op, in order. Lines that fail to parse are
 * skipped with a warning. Used by the UI to reconstruct op state on reload.
 */
export function readEvents(opId: string): OpEvent[] {
  const path = join(opDir(opId), "events.jsonl");
  if (!existsSync(path)) return [];
  try {
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(path, "utf-8") as string;
    const out: OpEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch {
        logger.warn(`[event-log] skipped unparseable line in ${opId}/events.jsonl`);
      }
    }
    return out;
  } catch (e) {
    logger.warn(`[event-log] failed to read events for ${opId}: ${(e as Error).message}`);
    return [];
  }
}

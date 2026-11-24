// Fact ingestion. Two sources:
//   - SQLite memory.db (retain-flagged facts written by memory_save tool)
//   - Daily markdown logs (~/.lax/memory/YYYY-MM-DD.md) parsed structurally
//
// The structural parser is deliberately strict: a fact must have either a
// kind marker (W/B/O/S) or a `(c=X)` confidence tag. Lines without either
// are chat transcript / log noise — without this gate a raw user message
// like "add X to sidebar" would become a "fact" with default 0.5
// confidence and pollute the consolidation pass.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { memoryDir, type FactEntry } from "./types.js";
import { getLaxDir } from "../../../lax-data-dir.js";
import { todayDateStr } from "./utils.js";
import { entityMentionRe } from "../../utils.js";
import { recallByTime } from "../../index-facts.js";

const require = createRequire(import.meta.url);

// SQLite reads a negative LIMIT as "no limit".
const EVERY_ROW = -1;

/**
 * The facts saved in the last `days` days that are still current, read with
 * the memory index's own query (recallByTime). This used to be its own SQL
 * with no validity filter, so a fact the user had forgotten or corrected was
 * still counted as recurring and its text copied into consolidation-log.json
 * every night for a month.
 */
export function loadSqliteFacts(days: number): FactEntry[] {
  try {
    const Database = require("better-sqlite3");
    const dbPath = join(getLaxDir(), "memory.db");
    if (!existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return recallByTime(db, since, undefined, EVERY_ROW).map((f) => ({
        content: f.content,
        entity: f.entities[0],
        confidence: f.confidence,
        accessCount: 1,
        createdAt: f.timestamp,
      }));
    } finally {
      db.close();
    }
  } catch {
    // No readable memory.db: the caller falls back to the daily logs.
    return [];
  }
}

export function loadTodayFacts(): FactEntry[] {
  const logPath = join(memoryDir(), `${todayDateStr()}.md`);
  if (!existsSync(logPath)) return [];
  return parseFactsFromLog(readFileSync(logPath, "utf-8"));
}

export function loadAllRecentFacts(days: number): FactEntry[] {
  const facts: FactEntry[] = [];
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  if (!existsSync(memoryDir())) return facts;

  const files = readdirSync(memoryDir()).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.md$/.test(f)
  );

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    const fileDate = new Date(dateStr).getTime();
    if (fileDate < cutoff) continue;

    const content = readFileSync(join(memoryDir(), file), "utf-8");
    facts.push(...parseFactsFromLog(content, fileDate));
  }

  return facts;
}

export function parseFactsFromLog(content: string, baseTime?: number): FactEntry[] {
  const facts: FactEntry[] = [];
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headers and empty lines
    if (trimmed.startsWith("#") || trimmed.length < 10) continue;

    // A fact is a structured entry written by the memory-save path. It has
    // EITHER a kind marker (W/B/O/S) optionally with a confidence tag,
    // OR an explicit `(c=X)` confidence marker somewhere in the line.
    // Lines without either are chat transcript or log noise — skip them,
    // otherwise a raw user message like "add X to sidebar" becomes a
    // "fact" with default 0.5 confidence and pollutes the consolidator.
    const withoutTimestamp = trimmed.replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "");
    const afterChatTag = withoutTimestamp.replace(/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s*/, "");
    const hasKindPrefix = /^[WBOS](?:\(c=[\d.]+\))?\s/.test(afterChatTag);
    const hasConfidenceMarker = /\(c=(\d+\.?\d*)\)/.test(trimmed);
    if (!hasKindPrefix && !hasConfidenceMarker) continue;

    // Reject transcript tags that slipped in anyway
    if (/^(User|Agent):\s/i.test(afterChatTag)) continue;

    // Extract entity from @mentions
    const entityMatch = trimmed.match(entityMentionRe(""));
    const entity = entityMatch ? entityMatch[1] : undefined;

    // Extract confidence if present
    const confMatch = trimmed.match(/\(c=(\d+\.?\d*)\)/);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

    // Clean content — strip timestamps, chat-id tags, kind prefix, @mentions
    const content = trimmed
      .replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "")
      .replace(/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s*/, "")
      .replace(/^[WBOS](?:\(c=[\d.]+\))?\s*/, "")
      .replace(entityMentionRe("g", String.raw`:?\s*`), "")
      .trim();

    if (content.length < 5) continue;

    facts.push({
      content,
      entity,
      confidence,
      accessCount: 1,
      createdAt: baseTime || Date.now(),
    });
  }

  return facts;
}

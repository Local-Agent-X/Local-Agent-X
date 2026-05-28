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
import { LAX_DIR, MEMORY_DIR, type FactEntry } from "./types.js";
import { todayDateStr } from "./utils.js";

const require = createRequire(import.meta.url);

export function loadSqliteFacts(days: number): FactEntry[] {
  try {
    const Database = require("better-sqlite3");
    const dbPath = join(LAX_DIR, "memory.db");
    if (!existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = db.prepare("SELECT content, entities, confidence, timestamp FROM facts WHERE timestamp > ? ORDER BY timestamp DESC").all(cutoff) as Array<{ content: string; entities: string; confidence: number; timestamp: number }>;
    db.close();
    return rows.map(r => ({
      content: r.content,
      entity: (() => { try { const e = JSON.parse(r.entities); return Array.isArray(e) && e.length > 0 ? e[0] : undefined; } catch { return undefined; } })(),
      confidence: r.confidence,
      accessCount: 1,
      createdAt: r.timestamp,
    }));
  } catch {
    return [];
  }
}

export function loadTodayFacts(): FactEntry[] {
  const logPath = join(MEMORY_DIR, `${todayDateStr()}.md`);
  if (!existsSync(logPath)) return [];
  return parseFactsFromLog(readFileSync(logPath, "utf-8"));
}

export function loadAllRecentFacts(days: number): FactEntry[] {
  const facts: FactEntry[] = [];
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  if (!existsSync(MEMORY_DIR)) return facts;

  const files = readdirSync(MEMORY_DIR).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.md$/.test(f)
  );

  for (const file of files) {
    const dateStr = file.replace(".md", "");
    const fileDate = new Date(dateStr).getTime();
    if (fileDate < cutoff) continue;

    const content = readFileSync(join(MEMORY_DIR, file), "utf-8");
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
    const entityMatch = trimmed.match(/@([\w-]+)/);
    const entity = entityMatch ? entityMatch[1] : undefined;

    // Extract confidence if present
    const confMatch = trimmed.match(/\(c=(\d+\.?\d*)\)/);
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;

    // Clean content — strip timestamps, chat-id tags, kind prefix, @mentions
    const content = trimmed
      .replace(/^\[[\d:]+\s*(?:AM|PM)?\]\s*/, "")
      .replace(/^\[(?:chat|ide|session|tg|cron|wa)-[A-Za-z0-9_-]+\]\s*/, "")
      .replace(/^[WBOS](?:\(c=[\d.]+\))?\s*/, "")
      .replace(/@[\w-]+:?\s*/g, "")
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

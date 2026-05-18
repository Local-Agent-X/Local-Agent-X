// Format detectors. Each detector takes a candidate file and returns a match
// with confidence + estimated record count, or null if it doesn't recognize
// the shape. Detectors should be cheap — sniff the head of the file, not
// parse the whole thing.

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { extname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export interface DetectionResult {
  format: string;
  confidence: number;        // 0..1
  estimatedRecords: number;  // approx conversation count or message count
  preview?: string;
}

const SNIFF_BYTES = 64 * 1024; // 64KB head read for JSON/JSONL files

// Read up to N bytes from the head of a file as utf-8 string.
function readHead(path: string, bytes: number): string {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

// ── JSON / JSONL detectors ──

export function detectFromJSON(path: string, size: number): DetectionResult | null {
  const ext = extname(path).toLowerCase();
  if (ext !== ".json" && ext !== ".jsonl" && ext !== ".ndjson") return null;

  const head = readHead(path, SNIFF_BYTES);
  if (!head.trim()) return null;

  // JSONL family — process line-by-line on the head sample
  if (ext === ".jsonl" || ext === ".ndjson" || (head.trim().startsWith("{") && head.includes("\n{"))) {
    return detectJSONL(head, size);
  }

  // Standard JSON — try parsing the head; if it fails (truncated), fall back
  // to substring sniffing for recognizable shapes.
  return detectJSON(head, size, path);
}

function detectJSONL(head: string, size: number): DetectionResult | null {
  const lines = head.split("\n").filter(l => l.trim()).slice(0, 20);
  if (lines.length === 0) return null;

  let claudeCodeHits = 0;
  let codexHits = 0;
  let genericHits = 0;
  let totalParsed = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      totalParsed++;
      if (obj.type === "session_meta" || obj.type === "event_msg") codexHits++;
      else if (obj.type === "human" || obj.type === "assistant" || obj.type === "user") claudeCodeHits++;
      else if (obj.role && obj.content !== undefined) genericHits++;
    } catch { /* skip malformed */ }
  }

  if (totalParsed === 0) return null;

  // Estimate record count from average line size on the head sample
  const avgLineSize = head.length / lines.length;
  const estRecords = Math.max(1, Math.round(size / avgLineSize));

  if (codexHits > 0 && codexHits >= claudeCodeHits) {
    return { format: "codex-cli", confidence: 0.85, estimatedRecords: estRecords };
  }
  if (claudeCodeHits > 0) {
    return { format: "claude-code", confidence: 0.85, estimatedRecords: estRecords };
  }
  if (genericHits > 0) {
    return { format: "generic-jsonl", confidence: 0.55, estimatedRecords: estRecords };
  }
  return null;
}

function detectJSON(head: string, size: number, path: string): DetectionResult | null {
  // Try parsing the full file if small enough; otherwise sniff substrings
  const trimmed = head.trim();
  const looksLikeArray = trimmed.startsWith("[");
  const looksLikeObject = trimmed.startsWith("{");
  if (!looksLikeArray && !looksLikeObject) return null;

  // For small files, parse directly for accurate counts
  if (size < SNIFF_BYTES) {
    try {
      const data = JSON.parse(trimmed);
      return classifyParsedJSON(data);
    } catch { /* fall through to sniff */ }
  }

  // Substring sniff for large files (truncated head)
  if (head.includes('"mapping"') && head.includes('"create_time"')) {
    // ChatGPT shape — count top-level conversation objects by occurrence
    // of "mapping" markers as a rough proxy
    const mappingCount = (head.match(/"mapping"\s*:/g) || []).length;
    const ratio = mappingCount / head.length;
    const est = Math.max(1, Math.round(size * ratio));
    return { format: "chatgpt", confidence: 0.85, estimatedRecords: est };
  }
  if (head.includes('"chat_messages"')) {
    const cmCount = (head.match(/"chat_messages"\s*:/g) || []).length;
    const ratio = cmCount / head.length;
    const est = Math.max(1, Math.round(size * ratio));
    return { format: "claude-ai", confidence: 0.8, estimatedRecords: est };
  }
  if (looksLikeArray && /"role"\s*:\s*"(user|assistant|system|human)"/i.test(head)) {
    const roleCount = (head.match(/"role"\s*:/g) || []).length;
    const ratio = roleCount / head.length;
    const est = Math.max(1, Math.round(size * ratio));
    return { format: "generic-json", confidence: 0.5, estimatedRecords: est };
  }
  void path;
  return null;
}

function classifyParsedJSON(data: unknown): DetectionResult | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    const first = data[0] as Record<string, unknown>;
    if (first?.mapping) {
      return { format: "chatgpt", confidence: 0.95, estimatedRecords: data.length };
    }
    if (first?.chat_messages) {
      return { format: "claude-ai", confidence: 0.95, estimatedRecords: data.length };
    }
    if (first?.type === "message" && first?.user) {
      return { format: "slack", confidence: 0.85, estimatedRecords: data.length };
    }
    if (first?.role && first?.content !== undefined) {
      return { format: "generic-json", confidence: 0.7, estimatedRecords: data.length };
    }
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (obj.mapping) return { format: "chatgpt", confidence: 0.9, estimatedRecords: 1 };
    if (obj.messages || obj.chat_messages) {
      const msgs = (obj.messages || obj.chat_messages) as unknown[];
      return { format: "claude-ai", confidence: 0.85, estimatedRecords: Array.isArray(msgs) ? msgs.length : 1 };
    }
  }
  return null;
}

// ── SQLite detector ──
// Opens the database read-only, inspects its schema for memory-shaped tables.

const MEMORY_TABLE_HINTS = ["messages", "memories", "memory", "conversations", "chats", "history", "embeddings", "facts"];

export function detectFromSQLite(path: string): DetectionResult | null {
  const ext = extname(path).toLowerCase();
  if (ext !== ".sqlite" && ext !== ".sqlite3" && ext !== ".db") return null;

  // Quick magic-bytes check before incurring the cost of opening with the driver
  const head = readHead(path, 16);
  if (!head.startsWith("SQLite format 3")) return null;

  let db: { close: () => void; prepare: (s: string) => { all: () => unknown[]; get: () => unknown } } | null = null;
  try {
    // Lazy require — avoids loading better-sqlite3 unless we hit a SQLite candidate
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    db = new Database(path, { readonly: true, fileMustExist: true }) as {
      close: () => void;
      prepare: (s: string) => { all: () => unknown[]; get: () => unknown };
    };
    if (!db) return null;
    // Keep both original-cased and lowercased names so the COUNT query uses the real identifier
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>;
    const tables = tableRows.map(r => ({ original: r.name, lower: r.name.toLowerCase() }));

    let matched: { original: string; lower: string } | null = null;
    for (const t of tables) {
      for (const h of MEMORY_TABLE_HINTS) {
        if (t.lower === h || t.lower.includes(h)) { matched = t; break; }
      }
      if (matched) break;
    }
    if (!matched) return null;

    let estRecords = 0;
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM "${matched.original.replace(/"/g, '""')}"`).get() as { c: number };
      estRecords = row?.c || 0;
    } catch { /* count failed — leave at 0 */ }

    return {
      format: `sqlite-${matched.lower}`,
      confidence: 0.7,
      estimatedRecords: estRecords,
    };
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

// ── Markdown / plain text ──
// Lower confidence — only flag if filename hints AND content has dialogue markers

export function detectFromText(path: string, size: number): DetectionResult | null {
  const ext = extname(path).toLowerCase();
  if (ext !== ".md" && ext !== ".txt") return null;
  if (size < 500) return null;

  const head = readHead(path, 16 * 1024);
  const lines = head.split("\n");
  const userMarkers = lines.filter(l => l.trim().startsWith(">")).length;
  if (userMarkers < 3) return null;

  // Rough estimate: one record per > marker
  const ratio = userMarkers / head.length;
  const est = Math.max(1, Math.round(size * ratio));
  return { format: "plain-text", confidence: 0.4, estimatedRecords: est };
}

// ── Top-level dispatcher ──

export function detectFile(path: string): DetectionResult | null {
  let size = 0;
  try { size = statSync(path).size; } catch { return null; }
  if (size === 0) return null;

  const ext = extname(path).toLowerCase();
  if (ext === ".json" || ext === ".jsonl" || ext === ".ndjson") {
    return detectFromJSON(path, size);
  }
  if (ext === ".sqlite" || ext === ".sqlite3" || ext === ".db") {
    return detectFromSQLite(path);
  }
  if (ext === ".md" || ext === ".txt") {
    return detectFromText(path, size);
  }
  return null;
}

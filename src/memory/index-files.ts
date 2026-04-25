import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { FileRecord } from "./types.js";

export function getMemoryFilePath(memoryDir: string): string {
  return join(memoryDir, "MIND.md");
}

export function getDailyLogPath(memoryDir: string, date?: Date): string {
  const d = date || new Date();
  const dateStr = d.toISOString().split("T")[0];
  return join(memoryDir, `${dateStr}.md`);
}

export function extractDateFromPath(path: string): string | undefined {
  const match = basename(path).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

export function listMemoryFiles(memoryDir: string): FileRecord[] {
  if (!existsSync(memoryDir)) return [];
  const records: FileRecord[] = [];

  const scanDir = (dir: string, source: string) => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          let childSource = source;
          if (entry.name === "entities") childSource = "entity";
          else if (entry.name === "session-summaries") childSource = "session-summary";
          scanDir(fullPath, childSource);
        }
      } else if (entry.name.endsWith(".md")) {
        let fileSource = source;
        if (source === "personality") {
          if (entry.name === "MIND.md") fileSource = "mind";
          else if (/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) fileSource = "daily-log";
        }
        try {
          const stat = statSync(fullPath);
          records.push({
            path: fullPath,
            source: fileSource,
            hash: `${stat.mtimeMs}:${stat.size}`,
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
        }
      }
    }
  };

  scanDir(memoryDir, "personality");
  return records;
}

export function listSessionFiles(dataDir: string): FileRecord[] {
  const sessDir = join(dataDir, "sessions");
  if (!existsSync(sessDir)) return [];
  const records: FileRecord[] = [];

  const files = readdirSync(sessDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const fullPath = join(sessDir, file);
    try {
      const stat = statSync(fullPath);
      records.push({
        path: fullPath,
        source: "session",
        hash: `${stat.mtimeMs}:${stat.size}`,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
    }
  }

  return records;
}


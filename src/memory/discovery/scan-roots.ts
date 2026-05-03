// OS-standard user-data locations where third-party tools commonly store memory.
// We scan these locations for memory-shaped files; the user's filesystem
// determines which apps are present, never a hardcoded list of brand names.

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// Directories we should never descend into during scan — high-noise, large,
// or known not to host agent memory.
export const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache",
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "Service Worker",
  "logs", "Logs", "tmp", "Temp", "temp",
  "Crashpad", "blob_storage", "IndexedDB", "Local Storage",
  "Session Storage", "WebStorage", "extensions", "Extensions",
  "WebGPUCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "media", "Media", "tessdata",
]);

// File extensions that might contain memory data.
export const CANDIDATE_EXTENSIONS = new Set([
  ".json", ".jsonl", ".ndjson",
  ".sqlite", ".sqlite3", ".db",
  ".md", ".txt",
]);

// Filename hints that boost candidate priority (case-insensitive substrings).
export const MEMORY_HINTS = [
  "memor", "conversation", "chat", "history", "session",
  "messages", "transcript", "thread", "dialogue", "convo",
  "export", "archive", "facts", "knowledge",
];

export function getScanRoots(): string[] {
  const home = homedir();
  const roots: string[] = [];
  const plat = platform();

  if (plat === "win32") {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) roots.push(appData);
    if (localAppData) roots.push(localAppData);
    roots.push(join(home, "Documents"));
    roots.push(join(home, "Downloads"));
    roots.push(join(home, "Desktop"));
  } else if (plat === "darwin") {
    roots.push(join(home, "Library", "Application Support"));
    roots.push(join(home, "Library", "Containers"));
    roots.push(join(home, "Documents"));
    roots.push(join(home, "Downloads"));
    roots.push(join(home, "Desktop"));
  } else {
    // linux + others
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share");
    roots.push(xdgConfig);
    roots.push(xdgData);
    roots.push(join(home, "Documents"));
    roots.push(join(home, "Downloads"));
  }

  return roots.filter(p => p && existsSync(p));
}

export function hasMemoryHint(name: string): boolean {
  const lower = name.toLowerCase();
  for (const hint of MEMORY_HINTS) if (lower.includes(hint)) return true;
  return false;
}

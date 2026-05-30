/**
 * Config Loader — reads config files from config/ directory and hot-reloads on change.
 *
 * The config/ directory is the "safe zone" — the agent can freely modify these files.
 * The src/ core reads from here but never gets modified by the agent.
 *
 * Files:
 *   config/system-prompt.md     — base system prompt (agent-editable)
 *   config/protected-files.json — list of files agent cannot modify (self-protecting)
 *   config/tools.json           — tool registry settings (eager/deferred/disabled)
 */

import { readFileSync, existsSync, watch } from "node:fs";
import { join, resolve, normalize } from "node:path";

import { createLogger } from "./logger.js";
const logger = createLogger("config-loader");

const CONFIG_DIR = resolve(join(import.meta.dirname || ".", "..", "config"));

// ── Cached values ──

let _systemPrompt: string | null = null;
let _protectedFiles: string[] | null = null;
let _toolsConfig: ToolsConfig | null = null;

interface ToolsConfig {
  eager: string[];
  disabled: string[];
  settings: Record<string, Record<string, unknown>>;
}

// ── Readers ──

/** Load the system prompt from config/system-prompt.md. Falls back to empty string. */
export function loadSystemPrompt(): string {
  if (_systemPrompt !== null) return _systemPrompt;
  const path = join(CONFIG_DIR, "system-prompt.md");
  try {
    _systemPrompt = readFileSync(path, "utf-8").trim();
  } catch {
    logger.warn("[config-loader] Could not read config/system-prompt.md — using empty prompt");
    _systemPrompt = "";
  }
  return _systemPrompt;
}

/** Load the protected files list from config/protected-files.json. */
export function loadProtectedFiles(): string[] {
  if (_protectedFiles !== null) return _protectedFiles;
  const path = join(CONFIG_DIR, "protected-files.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    _protectedFiles = (data.protected || []) as string[];
  } catch {
    logger.warn("[config-loader] Could not read config/protected-files.json — no files protected");
    _protectedFiles = [];
  }
  return _protectedFiles;
}

/** Load tool registry config from config/tools.json. */
export function loadToolsConfig(): ToolsConfig {
  if (_toolsConfig !== null) return _toolsConfig;
  const path = join(CONFIG_DIR, "tools.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    _toolsConfig = {
      eager: data.eager || [],
      disabled: data.disabled || [],
      settings: data.settings || {},
    };
  } catch {
    _toolsConfig = { eager: [], disabled: [], settings: {} };
  }
  return _toolsConfig;
}

/**
 * Match a candidate path against a single manifest entry. The candidate is
 * already normalized to forward slashes and may be absolute or repo-relative.
 * A trailing "/" on the entry protects the entire subtree (so splitting a
 * protected file into a directory keeps it protected). Matching is anchored to
 * path-segment boundaries: "src/security/" never matches "src/security-notes.ts"
 * and "src/auth.ts" never matches a file ending in "oauth.ts".
 */
export function pathMatchesProtected(candidate: string, entry: string): boolean {
  const isDir = entry.endsWith("/");
  const e = normalize(entry).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!e) return false;
  // File, or the directory node itself: candidate equals e or ends with "/<e>".
  const atBoundary = candidate === e || candidate.endsWith("/" + e);
  if (!isDir) return atBoundary;
  // Directory subtree: the dir itself, anything under it (".../<e>/..."), or a
  // repo-relative path that starts with "<e>/".
  return atBoundary || candidate.includes("/" + e + "/") || candidate.startsWith(e + "/");
}

/** Check if a file path is protected (cannot be modified by the agent). */
export function isProtectedFile(filePath: string): { protected: boolean; reason?: string } {
  const protectedList = loadProtectedFiles();
  // Normalize the path for comparison
  const normalized = normalize(filePath).replace(/\\/g, "/");

  // Load reasons
  let reasons: Record<string, string> = {};
  try {
    const path = join(CONFIG_DIR, "protected-files.json");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    reasons = data.reason || {};
  } catch {}

  for (const protectedPath of protectedList) {
    if (pathMatchesProtected(normalized, protectedPath)) {
      return {
        protected: true,
        reason: reasons[protectedPath] || `${protectedPath} is a protected core file`,
      };
    }
  }
  return { protected: false };
}

// ── Hot-reload watcher ──

let _watching = false;

/** Start watching config/ for changes and invalidate caches. */
export function startConfigWatcher(): void {
  if (_watching) return;
  if (!existsSync(CONFIG_DIR)) return;

  try {
    watch(CONFIG_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const name = filename.replace(/\\/g, "/");

      if (name === "system-prompt.md") {
        _systemPrompt = null;
        logger.info("[config-loader] Hot-reloaded system-prompt.md");
      } else if (name === "protected-files.json") {
        _protectedFiles = null;
        logger.info("[config-loader] Hot-reloaded protected-files.json");
      } else if (name === "tools.json") {
        _toolsConfig = null;
        logger.info("[config-loader] Hot-reloaded tools.json");
      }
    });
    _watching = true;
    logger.info("[config-loader] Watching config/ for changes");
  } catch (e) {
    logger.warn("[config-loader] Could not start file watcher:", (e as Error).message);
  }
}

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
    console.warn("[config-loader] Could not read config/system-prompt.md — using empty prompt");
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
    console.warn("[config-loader] Could not read config/protected-files.json — no files protected");
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
    const normalizedProtected = normalize(protectedPath).replace(/\\/g, "/");
    if (normalized.endsWith(normalizedProtected) || normalized === normalizedProtected) {
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
        console.log("[config-loader] Hot-reloaded system-prompt.md");
      } else if (name === "protected-files.json") {
        _protectedFiles = null;
        console.log("[config-loader] Hot-reloaded protected-files.json");
      } else if (name === "tools.json") {
        _toolsConfig = null;
        console.log("[config-loader] Hot-reloaded tools.json");
      }
    });
    _watching = true;
    console.log("[config-loader] Watching config/ for changes");
  } catch (e) {
    console.warn("[config-loader] Could not start file watcher:", (e as Error).message);
  }
}

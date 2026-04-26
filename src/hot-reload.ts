/**
 * Hot-Reload Module — watches src/ and public/ for changes and triggers
 * live reloading without full process restart.
 *
 * Only active when self-modify mode is enabled.
 * Works in dev mode (tsx --watch handles .ts transpilation).
 *
 * For .ts files: invalidates module cache, re-imports via dynamic import().
 * For public/ files: notifies WebSocket clients to refresh.
 * Core protected files are never hot-reloaded.
 */

import { watch, type FSWatcher } from "node:fs";
import { join, relative } from "node:path";
import { EventBus } from "./event-bus.js";

import { createLogger } from "./logger.js";
const logger = createLogger("hot-reload");

// Core files that are NEVER hot-reloaded (matches security.ts protected list)
const CORE_PROTECTED = new Set([
  "security.ts", "auth.ts", "codex-client.ts",
  "keychain.ts", "sanitize.ts", "threat-engine.ts", "rbac.ts",
  "safe-regex.ts", "tool-policy.ts",
]);

interface HotReloadEvent {
  path: string;
  type: "src" | "public";
  timestamp: number;
}

let srcWatcher: FSWatcher | null = null;
let publicWatcher: FSWatcher | null = null;
let active = false;

// Debounce map to avoid double-fires from fs.watch
const debounceMap = new Map<string, number>();
const DEBOUNCE_MS = 500;

function isDebounced(path: string): boolean {
  const last = debounceMap.get(path) || 0;
  const now = Date.now();
  if (now - last < DEBOUNCE_MS) return true;
  debounceMap.set(path, now);
  return false;
}

/**
 * Start watching src/ and public/ for changes.
 * @param projectRoot — the project root directory (where src/ and public/ live)
 */
export function startHotReload(projectRoot: string): void {
  if (active) return;
  active = true;

  const srcDir = join(projectRoot, "src");
  const publicDir = join(projectRoot, "public");

  // Watch src/ for .ts file changes
  try {
    srcWatcher = watch(srcDir, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".ts")) return;
      if (isDebounced(filename)) return;

      // Never reload core protected files
      const basename = filename.replace(/^.*[/\\]/, "");
      if (CORE_PROTECTED.has(basename)) {
        logger.info(`[hot-reload] Ignoring core file change: ${filename}`);
        return;
      }

      logger.info(`[hot-reload] Source changed: ${filename}`);
      const event: HotReloadEvent = {
        path: filename,
        type: "src",
        timestamp: Date.now(),
      };
      EventBus.emit("hot-reload:src", event);
    });
    logger.info("[hot-reload] Watching src/ for changes");
  } catch (e) {
    logger.warn(`[hot-reload] Failed to watch src/: ${(e as Error).message}`);
  }

  // Watch public/ for HTML/JS/CSS changes
  try {
    publicWatcher = watch(publicDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (isDebounced(filename)) return;

      logger.info(`[hot-reload] Public asset changed: ${filename}`);
      const event: HotReloadEvent = {
        path: filename,
        type: "public",
        timestamp: Date.now(),
      };
      EventBus.emit("hot-reload:public", event);
    });
    logger.info("[hot-reload] Watching public/ for changes");
  } catch (e) {
    logger.warn(`[hot-reload] Failed to watch public/: ${(e as Error).message}`);
  }

  // Emit a general hot-reload event for both types
  EventBus.on("hot-reload:src", (data) => {
    EventBus.emit("hot-reload:module", data);
  });

  EventBus.on("hot-reload:public", (data) => {
    EventBus.emit("hot-reload:asset", data);
  });
}

/**
 * Stop all file watchers.
 */
export function stopHotReload(): void {
  if (srcWatcher) { srcWatcher.close(); srcWatcher = null; }
  if (publicWatcher) { publicWatcher.close(); publicWatcher = null; }
  active = false;
  logger.info("[hot-reload] Stopped watching");
}

/**
 * Check if hot-reload is currently active.
 */
export function isHotReloadActive(): boolean {
  return active;
}

export type { HotReloadEvent };

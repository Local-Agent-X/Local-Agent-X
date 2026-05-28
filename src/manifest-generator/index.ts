/**
 * App Manifest Generator — scans the codebase and produces config/app-manifest.json.
 *
 * This gives the agent a complete map of its own app: every page, tab, route,
 * setting, tool, and capability. The agent reads this to know what already exists
 * so it doesn't rebuild things and knows where to make changes.
 *
 * Runs at startup and hot-reloads when source files change.
 */

export type {
  AppManifest,
  PageEntry,
  TabEntry,
  RouteEntry,
  ToolSummary,
  AppEntry,
  ConfigFileEntry,
} from "./types.js";

export { generateManifest, writeManifest } from "./generator.js";
export { getManifestSummary } from "./summary.js";
export { startManifestWatcher } from "./watcher.js";

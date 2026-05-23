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
} from "./manifest-generator/types.js";

export { generateManifest, writeManifest } from "./manifest-generator/generator.js";
export { getManifestSummary } from "./manifest-generator/summary.js";
export { startManifestWatcher } from "./manifest-generator/watcher.js";

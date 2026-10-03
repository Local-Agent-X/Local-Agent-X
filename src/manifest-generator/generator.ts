import { readFileSync, writeFileSync } from "node:fs";

import { createLogger } from "../logger.js";
import { checkEndpointAccess } from "../rbac.js";
import { MANIFEST_PATH } from "./paths.js";
import type { AppManifest, RouteEntry } from "./types.js";
import {
  scanPages,
  scanSettingsTabs,
  scanAgentTabs,
  scanTools,
  scanApps,
  scanConfigFiles,
} from "./scanners.js";
import { scanApiRoutes } from "./route-scanner.js";

const logger = createLogger("manifest-generator");

/**
 * The manifest is the agent's map of its own app, so it leaves out the routes
 * the agent's self-calls are refused on (rbac.ts): listed, they sent the agent
 * into dead ends it then tried to route around. A prefix route is scanned as
 * `/api/foo*`, and is checked as the prefix it names.
 */
function agentMayCall(route: RouteEntry): boolean {
  return checkEndpointAccess("agent", route.method, route.path.replace(/\*$/, "")).allowed;
}

export function generateManifest(): AppManifest {
  const manifest: AppManifest = {
    generatedAt: new Date().toISOString(),
    pages: scanPages(),
    settingsTabs: scanSettingsTabs(),
    agentTabs: scanAgentTabs(),
    apiRoutes: scanApiRoutes().filter(agentMayCall),
    tools: scanTools(),
    apps: scanApps(),
    configFiles: scanConfigFiles(),
    bridges: ["WhatsApp", "Telegram"],
    integrations: ["Google (Gmail, Calendar, Drive, YouTube)", "GitHub", "Slack", "Discord", "X", "Facebook", "Instagram", "Spotify", "eBay", "Notion", "Email (SMTP)"],
  };
  return manifest;
}

export function writeManifest(): void {
  const manifest = generateManifest();
  try {
    const existing = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as AppManifest;
    const { generatedAt: _existingGeneratedAt, ...existingContent } = existing;
    const { generatedAt: _nextGeneratedAt, ...nextContent } = manifest;
    if (JSON.stringify(existingContent) === JSON.stringify(nextContent)) return;
  } catch {
    // Missing or malformed manifests are replaced below.
  }
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    logger.info(`[manifest] Generated app-manifest.json (${manifest.pages.length} pages, ${manifest.apiRoutes.length} routes, ${manifest.tools.length} tools, ${manifest.apps.length} apps)`);
  } catch (e) {
    logger.warn("[manifest] Failed to write app-manifest.json:", (e as Error).message);
  }
}

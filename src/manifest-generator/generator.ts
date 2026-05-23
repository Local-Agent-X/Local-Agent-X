import { writeFileSync } from "node:fs";

import { createLogger } from "../logger.js";
import { MANIFEST_PATH } from "./paths.js";
import type { AppManifest } from "./types.js";
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

export function generateManifest(): AppManifest {
  const manifest: AppManifest = {
    generatedAt: new Date().toISOString(),
    pages: scanPages(),
    settingsTabs: scanSettingsTabs(),
    agentTabs: scanAgentTabs(),
    apiRoutes: scanApiRoutes(),
    tools: scanTools(),
    apps: scanApps(),
    configFiles: scanConfigFiles(),
    bridges: ["WhatsApp", "Telegram"],
    integrations: ["Google (Gmail, Calendar, Drive, YouTube)", "GitHub", "Slack", "Discord", "Twitter/X", "Facebook", "Instagram", "Spotify", "eBay", "Notion", "Email (SMTP)"],
  };
  return manifest;
}

export function writeManifest(): void {
  const manifest = generateManifest();
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    logger.info(`[manifest] Generated app-manifest.json (${manifest.pages.length} pages, ${manifest.apiRoutes.length} routes, ${manifest.tools.length} tools, ${manifest.apps.length} apps)`);
  } catch (e) {
    logger.warn("[manifest] Failed to write app-manifest.json:", (e as Error).message);
  }
}

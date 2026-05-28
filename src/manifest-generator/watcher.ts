import { existsSync, watch } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { ROOT, CONFIG_DIR } from "./paths.js";
import { writeManifest } from "./generator.js";

const logger = createLogger("manifest-generator");

let _manifestWatching = false;

export function startManifestWatcher(): void {
  if (_manifestWatching) return;

  const watchDirs = [
    join(ROOT, "public"),
    join(ROOT, "src", "routes"),
    join(ROOT, "workspace", "apps"),
    CONFIG_DIR,
  ];

  const appsDir = join(ROOT, "workspace", "apps");

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;
    try {
      let debounce: NodeJS.Timeout | null = null;
      // Per-app debounce so a flurry of edits doesn't re-broadcast 20 reload events
      const appDebounce = new Map<string, NodeJS.Timeout>();
      watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && filename.toString().includes("app-manifest")) return;

        // workspace/apps/<name>/... -> broadcast app-files-changed so any
        // pinned iframe for that app auto-reloads.
        if (dir === appsDir && filename) {
          const rel = filename.toString().replace(/\\/g, "/");
          const appName = rel.split("/")[0];
          if (appName && appName !== "." && !appName.startsWith(".")) {
            const existing = appDebounce.get(appName);
            if (existing) clearTimeout(existing);
            appDebounce.set(appName, setTimeout(() => {
              appDebounce.delete(appName);
              import("../chat-ws/index.js").then(({ broadcastAll }) => {
                try { broadcastAll({ type: "app-files-changed", appName }); }
                catch (e) { logger.warn(`[manifest] app-files-changed broadcast failed: ${(e as Error).message}`); }
              }).catch(() => {});
            }, 400));
          }
        }

        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          writeManifest();
        }, 5000);
      });
    } catch {}
  }
  _manifestWatching = true;
  logger.info("[manifest] Watching for changes (public/, src/routes/, workspace/apps/, config/)");
}

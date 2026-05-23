import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { appDir, defPath, eventsPath, statePath } from "./paths.js";
import type { AppDefinition, AppState, AppStatus, AppVisibility, AuditEntry } from "./types.js";

type AuditWriter = (appId: string, actor: string, action: string, details?: Record<string, unknown>) => AuditEntry;

export function migrateFromDashboards(writeAudit: AuditWriter): void {
  const oldDir = join(homedir(), ".lax", "dashboards");
  if (!existsSync(oldDir)) return;

  try {
    const dirs = readdirSync(oldDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      if (d.name === "_audit") continue;
      const oldDefPath = join(oldDir, d.name, "definition.json");
      const newDefPath = defPath(d.name);
      if (existsSync(oldDefPath) && !existsSync(newDefPath)) {
        try {
          const oldDef = JSON.parse(readFileSync(oldDefPath, "utf-8"));
          const appDef: AppDefinition = {
            ...oldDef,
            status: "active" as AppStatus,
            version: oldDef.version || 1,
            permissions: oldDef.permissions || {
              owner: "user",
              visibility: "team" as AppVisibility,
              allowedAgents: [],
              accessLevels: {},
            },
          };
          const dir = appDir(d.name);
          mkdirSync(dir, { recursive: true });
          writeFileSync(newDefPath, JSON.stringify(appDef, null, 2), "utf-8");

          const oldStatePath = join(oldDir, d.name, "state.json");
          const oldEventsPath = join(oldDir, d.name, "events.json");
          if (existsSync(oldStatePath)) {
            const oldState = JSON.parse(readFileSync(oldStatePath, "utf-8"));
            const newState: AppState = {
              ...oldState,
              metadata: { ...oldState.metadata, version: 1 },
            };
            writeFileSync(statePath(d.name), JSON.stringify(newState, null, 2), "utf-8");
          }
          if (existsSync(oldEventsPath)) {
            const events = readFileSync(oldEventsPath, "utf-8");
            writeFileSync(eventsPath(d.name), events, "utf-8");
          }

          writeAudit(d.name, "system", "app:migrated", { from: "dashboard" });
        } catch { /* skip broken entries */ }
      }
    }
  } catch { /* dashboards dir doesn't exist or is unreadable */ }
}

import { existsSync, mkdirSync } from "node:fs";
import { getLaxDir } from "../lax-data-dir.js";
import { join } from "node:path";

export const APPS_DIR = join(getLaxDir(), "apps");
export const AUDIT_DIR = join(getLaxDir(), "apps", "_audit");

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appDir(id: string): string { return join(APPS_DIR, id); }
export function defPath(id: string): string { return join(appDir(id), "definition.json"); }
export function statePath(id: string): string { return join(appDir(id), "state.json"); }
export function eventsPath(id: string): string { return join(appDir(id), "events.json"); }
export function auditPath(id: string): string { return join(appDir(id), "audit.json"); }

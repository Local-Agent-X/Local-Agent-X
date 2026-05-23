import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { readAuditLog, readGlobalAuditLog, writeAuditEntry } from "./audit.js";
import { consumeEvents, getUnconsumedEvents, pushEvent, readEvents } from "./events-store.js";
import { migrateFromDashboards } from "./migration.js";
import { APPS_DIR, AUDIT_DIR, appDir, defPath, ensureDir, eventsPath, statePath } from "./paths.js";
import { type AccessResult, checkAccess } from "./permissions.js";
import { RateLimiter } from "./rate-limiter.js";
import {
  consumeActions,
  getPendingActions,
  queueAction,
  readState,
  updateComponentValues,
  writeState,
} from "./state-store.js";
import {
  type AccessLevel,
  type AppDefinition,
  type AppEvent,
  type AppState,
  type AuditEntry,
  MAX_APPS_TOTAL,
  type QueuedAction,
} from "./types.js";
import { validateAppDefinition } from "./validation.js";
import { createLogger } from "../logger.js";

const logger = createLogger("app-runtime");

export class AppRegistry {
  private static instance: AppRegistry;
  private stateRateLimiter = new RateLimiter(60, 60_000);
  private eventRateLimiter = new RateLimiter(120, 60_000);
  private migrated = false;

  private constructor() {
    ensureDir(APPS_DIR);
    ensureDir(AUDIT_DIR);
    this.runMigration();
  }

  static getInstance(): AppRegistry {
    if (!AppRegistry.instance) {
      AppRegistry.instance = new AppRegistry();
    }
    return AppRegistry.instance;
  }

  private runMigration(): void {
    if (this.migrated) return;
    this.migrated = true;
    migrateFromDashboards((appId, actor, action, details) => writeAuditEntry(appId, actor, action, details));
  }

  // ── Audit ──

  getAuditLog(appId: string, limit = 50): AuditEntry[] {
    return readAuditLog(appId, limit);
  }

  getGlobalAuditLog(limit = 100): AuditEntry[] {
    return readGlobalAuditLog(limit);
  }

  // ── Permission Checks ──

  checkAccess(appId: string, actor: string, requiredLevel: AccessLevel): AccessResult {
    return checkAccess(this.get(appId), actor, requiredLevel);
  }

  // ── CRUD ──

  create(def: AppDefinition, actor = "user"): { app?: AppDefinition; error?: string } {
    const validation = validateAppDefinition(def);
    if (!validation.valid) return { error: `Validation failed: ${validation.errors.join("; ")}` };

    const existing = this.list();
    if (existing.length >= MAX_APPS_TOTAL) return { error: `App limit reached (max ${MAX_APPS_TOTAL})` };

    if (this.get(def.id)) return { error: `App "${def.id}" already exists` };

    def.status = def.status || "active";
    def.version = 1;
    def.permissions = def.permissions || {
      owner: actor,
      visibility: "team",
      allowedAgents: [],
      accessLevels: {},
    };
    def.createdAt = def.createdAt || Date.now();
    def.updatedAt = Date.now();

    const dir = appDir(def.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(defPath(def.id), JSON.stringify(def, null, 2), "utf-8");

    const state: AppState = {
      componentValues: {},
      actionQueue: [],
      metadata: { lastAgentUpdate: Date.now(), lastUserUpdate: 0, version: 1 },
    };
    writeFileSync(statePath(def.id), JSON.stringify(state, null, 2), "utf-8");
    writeFileSync(eventsPath(def.id), "[]", "utf-8");

    writeAuditEntry(def.id, actor, "app:create", {
      name: def.name,
      components: def.components.length,
      layout: def.layout.type,
      visibility: def.permissions.visibility,
    });

    return { app: def };
  }

  get(id: string): AppDefinition | null {
    const p = defPath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); }
    catch (e) {
      // Corrupted app definition surfaces to the caller as "not found",
      // which then shows "App not found" / "Access denied" in the UI —
      // very confusing when the file exists but is unreadable. Log so
      // a corrupted JSON in ~/.lax/apps/<id>/def.json is debuggable.
      logger.warn(`failed to parse app definition ${id}: ${(e as Error).message}`);
      return null;
    }
  }

  update(id: string, partial: Partial<AppDefinition>, actor = "user"): { app?: AppDefinition; error?: string } {
    const existing = this.get(id);
    if (!existing) return { error: "App not found" };

    const access = this.checkAccess(id, actor, "write");
    if (!access.allowed) return { error: access.reason || "Access denied" };

    if (partial.components) {
      const validation = validateAppDefinition({ ...existing, ...partial });
      if (!validation.valid) return { error: `Validation failed: ${validation.errors.join("; ")}` };
    }

    const updated: AppDefinition = {
      ...existing,
      ...partial,
      id,
      version: existing.version + 1,
      updatedAt: Date.now(),
      permissions: partial.permissions
        ? { ...existing.permissions, ...partial.permissions }
        : existing.permissions,
    };
    writeFileSync(defPath(id), JSON.stringify(updated, null, 2), "utf-8");

    writeAuditEntry(id, actor, "app:update", {
      version: updated.version,
      changed: Object.keys(partial),
    });

    return { app: updated };
  }

  delete(id: string, actor = "user"): { deleted: boolean; error?: string } {
    const def = this.get(id);
    if (!def) return { deleted: false, error: "App not found" };

    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { deleted: false, error: access.reason || "Access denied" };

    writeAuditEntry(id, actor, "app:delete", { name: def.name });

    const dir = appDir(id);
    try { rmSync(dir, { recursive: true, force: true }); return { deleted: true }; } catch { return { deleted: false, error: "Failed to remove app directory" }; }
  }

  list(actor?: string): AppDefinition[] {
    ensureDir(APPS_DIR);
    const dirs = readdirSync(APPS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "_audit");
    const results: AppDefinition[] = [];
    for (const d of dirs) {
      const def = this.get(d.name);
      if (!def) continue;
      if (actor) {
        const access = this.checkAccess(d.name, actor, "read");
        if (!access.allowed) continue;
      }
      results.push(def);
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── Lifecycle ──

  suspend(id: string, actor = "user"): { success: boolean; error?: string } {
    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };
    const result = this.update(id, { status: "suspended" }, actor);
    if (result.error) return { success: false, error: result.error };
    writeAuditEntry(id, actor, "app:suspend", {});
    return { success: true };
  }

  activate(id: string, actor = "user"): { success: boolean; error?: string } {
    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };
    const result = this.update(id, { status: "active" }, actor);
    if (result.error) return { success: false, error: result.error };
    writeAuditEntry(id, actor, "app:activate", {});
    return { success: true };
  }

  archive(id: string, actor = "user"): { success: boolean; error?: string } {
    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };
    const result = this.update(id, { status: "archived" }, actor);
    if (result.error) return { success: false, error: result.error };
    writeAuditEntry(id, actor, "app:archive", {});
    return { success: true };
  }

  // ── State Management ──

  getState(id: string): AppState | null {
    return readState(id);
  }

  setState(id: string, state: AppState): void {
    writeState(id, state);
  }

  updateComponentValues(id: string, values: Record<string, unknown>, actor = "user"): { state?: AppState; error?: string } {
    return updateComponentValues(id, values, actor, this.stateRateLimiter, writeAuditEntry);
  }

  queueAction(id: string, action: string, target?: string, value?: unknown, actor = "user"): { action?: QueuedAction; error?: string } {
    return queueAction(id, action, target, value, actor, writeAuditEntry);
  }

  consumeActions(id: string, actionIds: string[]): void {
    consumeActions(id, actionIds);
  }

  getPendingActions(id: string): QueuedAction[] {
    return getPendingActions(id);
  }

  // ── Events ──

  getEvents(id: string, since?: number): AppEvent[] {
    return readEvents(id, since);
  }

  pushEvent(id: string, event: Omit<AppEvent, "id" | "timestamp" | "consumed">, _actor = "user"): { event?: AppEvent; error?: string } {
    return pushEvent(id, event, this.eventRateLimiter);
  }

  consumeEvents(id: string, eventIds: string[]): void {
    consumeEvents(id, eventIds);
  }

  getUnconsumedEvents(id: string): AppEvent[] {
    return getUnconsumedEvents(id);
  }

  // ── Permissions Management ──

  grantAccess(appId: string, agentId: string, level: AccessLevel, actor = "user"): { success: boolean; error?: string } {
    const def = this.get(appId);
    if (!def) return { success: false, error: "App not found" };

    const access = this.checkAccess(appId, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };

    if (!def.permissions.allowedAgents.includes(agentId)) {
      def.permissions.allowedAgents.push(agentId);
    }
    def.permissions.accessLevels[agentId] = level;
    writeFileSync(defPath(appId), JSON.stringify(def, null, 2), "utf-8");

    writeAuditEntry(appId, actor, "access:grant", { agentId, level });
    return { success: true };
  }

  revokeAccess(appId: string, agentId: string, actor = "user"): { success: boolean; error?: string } {
    const def = this.get(appId);
    if (!def) return { success: false, error: "App not found" };

    const access = this.checkAccess(appId, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };

    def.permissions.allowedAgents = def.permissions.allowedAgents.filter(a => a !== agentId);
    delete def.permissions.accessLevels[agentId];
    writeFileSync(defPath(appId), JSON.stringify(def, null, 2), "utf-8");

    writeAuditEntry(appId, actor, "access:revoke", { agentId });
    return { success: true };
  }
}

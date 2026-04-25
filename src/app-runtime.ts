/**
 * App Runtime — enterprise-grade app platform with security, permissions, and audit.
 *
 * Apps are interactive mini-applications that agents create, use, and operate.
 * Unlike passive dashboards, apps are bidirectional: agents read user interactions
 * and update state in real-time. Apps are the agent's operational workspace.
 *
 * Security model:
 * - Per-app permissions (owner, visibility, allowed agents, access levels)
 * - Immutable audit trail for every mutation
 * - Input validation with size limits and type enforcement
 * - App lifecycle states (active, suspended, archived)
 * - Component type whitelist
 *
 * Persisted to ~/.sax/apps/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────

export type ComponentType =
  | "button" | "text" | "input" | "form" | "table" | "chart"
  | "list" | "stat" | "image" | "select" | "toggle" | "custom"
  | "progress" | "alert" | "code" | "markdown" | "divider"
  | "tabs" | "accordion" | "modal" | "badge" | "avatar";

const ALLOWED_COMPONENT_TYPES = new Set<string>([
  "button", "text", "input", "form", "table", "chart",
  "list", "stat", "image", "select", "toggle", "custom",
  "progress", "alert", "code", "markdown", "divider",
  "tabs", "accordion", "modal", "badge", "avatar",
]);

export interface ComponentDefinition {
  id: string;
  type: ComponentType;
  props: Record<string, unknown>;
  children?: ComponentDefinition[];
}

export interface DataBinding {
  componentId: string;
  property: string;
  source: "agent" | "api" | "computed";
  expression: string;
}

export interface ActionDefinition {
  name: string;
  targetComponent?: string;
  handler: string;
}

export interface EventDefinition {
  name: string;
  sourceComponent?: string;
  description: string;
}

export type LayoutType = "grid" | "flex" | "stack" | "tabs" | "sidebar" | "custom";

export interface LayoutDefinition {
  type: LayoutType;
  columns?: number;
  gap?: string;
  areas?: string[][];
}

// ── Security & Permissions ───────────────────────────────────

export type AppVisibility = "private" | "team" | "public";
export type AppStatus = "active" | "suspended" | "archived";
export type AccessLevel = "read" | "write" | "admin";

export interface AppPermissions {
  owner: string;                              // agent ID or 'user'
  visibility: AppVisibility;
  allowedAgents: string[];                    // agent IDs with access
  accessLevels: Record<string, AccessLevel>;  // agentId -> level
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string;       // agent ID, 'user', or 'system'
  action: string;      // 'app:create', 'app:update', 'app:delete', 'state:update', 'event:push', etc.
  appId: string;
  details: Record<string, unknown>;
  signature: string;   // HMAC signature for tamper detection
}

// ── App Definition ───────────────────────────────────────────

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  components: ComponentDefinition[];
  dataBindings: DataBinding[];
  actions: ActionDefinition[];
  events: EventDefinition[];
  layout: LayoutDefinition;
  standalone?: boolean;
  status: AppStatus;
  permissions: AppPermissions;
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ── State ────────────────────────────────────────────────────

export interface AppState {
  componentValues: Record<string, unknown>;
  actionQueue: QueuedAction[];
  metadata: {
    lastAgentUpdate: number;
    lastUserUpdate: number;
    version: number;
  };
}

export interface QueuedAction {
  id: string;
  action: string;
  target?: string;
  value?: unknown;
  timestamp: number;
  consumed: boolean;
}

export interface AppEvent {
  id: string;
  appId: string;
  type: string;
  sourceComponent?: string;
  data: unknown;
  timestamp: number;
  consumed: boolean;
}

// ── Validation ───────────────────────────────────────────────

const MAX_COMPONENTS = 200;
const MAX_EVENTS_STORED = 500;
const MAX_ACTIONS_QUEUED = 100;
const MAX_STATE_SIZE_BYTES = 2 * 1024 * 1024;  // 2MB
const MAX_APP_NAME_LENGTH = 128;
const MAX_APP_DESC_LENGTH = 1024;
const MAX_COMPONENT_ID_LENGTH = 64;
const MAX_APPS_TOTAL = 500;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAppId(id: string): ValidationResult {
  const errors: string[] = [];
  if (!id) errors.push("App ID is required");
  if (id.length > 64) errors.push("App ID must be 64 characters or fewer");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) errors.push("App ID must start with alphanumeric and contain only [a-zA-Z0-9_-]");
  return { valid: errors.length === 0, errors };
}

export function validateComponent(comp: ComponentDefinition, depth = 0): ValidationResult {
  const errors: string[] = [];
  if (depth > 5) { errors.push(`Component nesting too deep (max 5 levels)`); return { valid: false, errors }; }
  if (!comp.id) errors.push("Component missing ID");
  if (comp.id && comp.id.length > MAX_COMPONENT_ID_LENGTH) errors.push(`Component ID "${comp.id}" exceeds ${MAX_COMPONENT_ID_LENGTH} chars`);
  if (!ALLOWED_COMPONENT_TYPES.has(comp.type)) errors.push(`Invalid component type "${comp.type}"`);
  if (comp.id && /[<>"'&]/.test(comp.id)) errors.push(`Component ID "${comp.id}" contains unsafe characters`);
  if (comp.children) {
    for (const child of comp.children) {
      const childResult = validateComponent(child, depth + 1);
      errors.push(...childResult.errors);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateAppDefinition(def: Partial<AppDefinition>): ValidationResult {
  const errors: string[] = [];

  if (def.id) {
    const idResult = validateAppId(def.id);
    errors.push(...idResult.errors);
  }

  if (def.name && def.name.length > MAX_APP_NAME_LENGTH) errors.push(`App name exceeds ${MAX_APP_NAME_LENGTH} chars`);
  if (def.description && def.description.length > MAX_APP_DESC_LENGTH) errors.push(`App description exceeds ${MAX_APP_DESC_LENGTH} chars`);

  if (def.components) {
    if (def.components.length > MAX_COMPONENTS) errors.push(`Too many components (max ${MAX_COMPONENTS})`);
    const ids = new Set<string>();
    for (const comp of def.components) {
      const compResult = validateComponent(comp);
      errors.push(...compResult.errors);
      if (comp.id) {
        if (ids.has(comp.id)) errors.push(`Duplicate component ID "${comp.id}"`);
        ids.add(comp.id);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Audit System ─────────────────────────────────────────────

const AUDIT_HMAC_KEY = (process.env.LAX_AUDIT_KEY ?? process.env.SAX_AUDIT_KEY) || randomBytes(32).toString("hex");

function signAuditEntry(entry: Omit<AuditEntry, "signature">): string {
  const payload = `${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.appId}`;
  return createHmac("sha256", AUDIT_HMAC_KEY).update(payload).digest("hex").slice(0, 16);
}

export function verifyAuditEntry(entry: AuditEntry): boolean {
  const expected = signAuditEntry(entry);
  return entry.signature === expected;
}

// ── Rate Limiter ─────────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private buckets = new Map<string, RateBucket>();
  private maxPerWindow: number;
  private windowMs: number;

  constructor(maxPerWindow: number, windowMs: number) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  check(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.maxPerWindow) return false;
    bucket.count++;
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

// ── Registry ─────────────────────────────────────────────────

const APPS_DIR = join(homedir(), ".lax", "apps");
const AUDIT_DIR = join(homedir(), ".lax", "apps", "_audit");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appDir(id: string): string { return join(APPS_DIR, id); }
function defPath(id: string): string { return join(appDir(id), "definition.json"); }
function statePath(id: string): string { return join(appDir(id), "state.json"); }
function eventsPath(id: string): string { return join(appDir(id), "events.json"); }
function auditPath(id: string): string { return join(appDir(id), "audit.json"); }

export class AppRegistry {
  private static instance: AppRegistry;
  private stateRateLimiter = new RateLimiter(60, 60_000);   // 60 state updates/min per app
  private eventRateLimiter = new RateLimiter(120, 60_000);   // 120 events/min per app
  private migrated = false;

  private constructor() {
    ensureDir(APPS_DIR);
    ensureDir(AUDIT_DIR);
    this.migrateFromDashboards();
  }

  static getInstance(): AppRegistry {
    if (!AppRegistry.instance) {
      AppRegistry.instance = new AppRegistry();
    }
    return AppRegistry.instance;
  }

  /** Migrate existing dashboards to apps (one-time) */
  private migrateFromDashboards(): void {
    if (this.migrated) return;
    this.migrated = true;
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
            // Convert old dashboard to new app format
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

            // Copy state and events if they exist
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

            this.writeAudit(d.name, "system", "app:migrated", { from: "dashboard" });
          } catch { /* skip broken entries */ }
        }
      }
    } catch { /* dashboards dir doesn't exist or is unreadable */ }
  }

  // ── Audit ──

  private writeAudit(appId: string, actor: string, action: string, details: Record<string, unknown> = {}): AuditEntry {
    const entry: Omit<AuditEntry, "signature"> = {
      id: `aud_${Date.now()}_${randomBytes(4).toString("hex")}`,
      timestamp: Date.now(),
      actor,
      action,
      appId,
      details,
    };
    const signed: AuditEntry = { ...entry, signature: signAuditEntry(entry) };

    // Per-app audit
    const appAuditPath = auditPath(appId);
    let entries: AuditEntry[] = [];
    try { if (existsSync(appAuditPath)) entries = JSON.parse(readFileSync(appAuditPath, "utf-8")); } catch { entries = []; }
    entries.push(signed);
    if (entries.length > 1000) entries = entries.slice(-1000);
    try { writeFileSync(appAuditPath, JSON.stringify(entries, null, 2), "utf-8"); } catch { /* best effort */ }

    // Global audit log (append-only, rotating)
    const globalPath = join(AUDIT_DIR, "global.json");
    let global: AuditEntry[] = [];
    try { if (existsSync(globalPath)) global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch { global = []; }
    global.push(signed);
    if (global.length > 5000) global = global.slice(-5000);
    try { writeFileSync(globalPath, JSON.stringify(global, null, 2), "utf-8"); } catch { /* best effort */ }

    return signed;
  }

  getAuditLog(appId: string, limit = 50): AuditEntry[] {
    const p = auditPath(appId);
    if (!existsSync(p)) return [];
    try {
      const entries: AuditEntry[] = JSON.parse(readFileSync(p, "utf-8"));
      return entries.slice(-limit);
    } catch { return []; }
  }

  getGlobalAuditLog(limit = 100): AuditEntry[] {
    const p = join(AUDIT_DIR, "global.json");
    if (!existsSync(p)) return [];
    try {
      const entries: AuditEntry[] = JSON.parse(readFileSync(p, "utf-8"));
      return entries.slice(-limit);
    } catch { return []; }
  }

  // ── Permission Checks ──

  checkAccess(appId: string, actor: string, requiredLevel: AccessLevel): { allowed: boolean; reason?: string } {
    const def = this.get(appId);
    if (!def) return { allowed: false, reason: "App not found" };

    // Owner always has full access
    if (def.permissions.owner === actor) return { allowed: true };

    // Check app status
    if (def.status === "suspended") return { allowed: false, reason: "App is suspended" };
    if (def.status === "archived" && requiredLevel !== "read") return { allowed: false, reason: "App is archived (read-only)" };

    // Public apps allow read access to everyone
    if (def.permissions.visibility === "public" && requiredLevel === "read") return { allowed: true };

    // Team apps allow read access to all agents
    if (def.permissions.visibility === "team" && requiredLevel === "read") return { allowed: true };
    if (def.permissions.visibility === "team" && def.permissions.allowedAgents.includes(actor)) {
      const level = def.permissions.accessLevels[actor] || "read";
      if (meetsAccessLevel(level, requiredLevel)) return { allowed: true };
    }

    // Check explicit agent permissions
    if (def.permissions.allowedAgents.includes(actor)) {
      const level = def.permissions.accessLevels[actor] || "read";
      if (meetsAccessLevel(level, requiredLevel)) return { allowed: true };
    }

    // 'user' actor always has admin
    if (actor === "user") return { allowed: true };

    return { allowed: false, reason: `Insufficient permissions (need ${requiredLevel})` };
  }

  // ── CRUD ──

  create(def: AppDefinition, actor = "user"): { app?: AppDefinition; error?: string } {
    // Validate
    const validation = validateAppDefinition(def);
    if (!validation.valid) return { error: `Validation failed: ${validation.errors.join("; ")}` };

    // Check total app limit
    const existing = this.list();
    if (existing.length >= MAX_APPS_TOTAL) return { error: `App limit reached (max ${MAX_APPS_TOTAL})` };

    if (this.get(def.id)) return { error: `App "${def.id}" already exists` };

    // Set defaults
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

    // Initialize state
    const state: AppState = {
      componentValues: {},
      actionQueue: [],
      metadata: { lastAgentUpdate: Date.now(), lastUserUpdate: 0, version: 1 },
    };
    writeFileSync(statePath(def.id), JSON.stringify(state, null, 2), "utf-8");
    writeFileSync(eventsPath(def.id), "[]", "utf-8");

    this.writeAudit(def.id, actor, "app:create", {
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
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }

  update(id: string, partial: Partial<AppDefinition>, actor = "user"): { app?: AppDefinition; error?: string } {
    const existing = this.get(id);
    if (!existing) return { error: "App not found" };

    // Check access
    const access = this.checkAccess(id, actor, "write");
    if (!access.allowed) return { error: access.reason || "Access denied" };

    // Validate changes
    if (partial.components) {
      const validation = validateAppDefinition({ ...existing, ...partial });
      if (!validation.valid) return { error: `Validation failed: ${validation.errors.join("; ")}` };
    }

    const updated: AppDefinition = {
      ...existing,
      ...partial,
      id,  // prevent ID change
      version: existing.version + 1,
      updatedAt: Date.now(),
      permissions: partial.permissions
        ? { ...existing.permissions, ...partial.permissions }
        : existing.permissions,
    };
    writeFileSync(defPath(id), JSON.stringify(updated, null, 2), "utf-8");

    this.writeAudit(id, actor, "app:update", {
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

    this.writeAudit(id, actor, "app:delete", { name: def.name });

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
      // Filter by access if actor specified
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
    this.writeAudit(id, actor, "app:suspend", {});
    return { success: true };
  }

  activate(id: string, actor = "user"): { success: boolean; error?: string } {
    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };
    const result = this.update(id, { status: "active" }, actor);
    if (result.error) return { success: false, error: result.error };
    this.writeAudit(id, actor, "app:activate", {});
    return { success: true };
  }

  archive(id: string, actor = "user"): { success: boolean; error?: string } {
    const access = this.checkAccess(id, actor, "admin");
    if (!access.allowed) return { success: false, error: access.reason };
    const result = this.update(id, { status: "archived" }, actor);
    if (result.error) return { success: false, error: result.error };
    this.writeAudit(id, actor, "app:archive", {});
    return { success: true };
  }

  // ── State Management ──

  getState(id: string): AppState | null {
    const p = statePath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }

  setState(id: string, state: AppState): void {
    const dir = appDir(id);
    if (!existsSync(dir)) return;

    // Size check
    const serialized = JSON.stringify(state, null, 2);
    if (serialized.length > MAX_STATE_SIZE_BYTES) return;

    writeFileSync(statePath(id), serialized, "utf-8");
  }

  updateComponentValues(id: string, values: Record<string, unknown>, actor = "user"): { state?: AppState; error?: string } {
    // Rate limit
    if (!this.stateRateLimiter.check(`state:${id}`)) {
      return { error: "Rate limit exceeded for state updates" };
    }

    const state = this.getState(id);
    if (!state) return { error: "App not found" };

    state.componentValues = { ...state.componentValues, ...values };
    state.metadata.lastAgentUpdate = Date.now();
    state.metadata.version++;
    this.setState(id, state);

    this.writeAudit(id, actor, "state:update", {
      components: Object.keys(values),
      version: state.metadata.version,
    });

    return { state };
  }

  queueAction(id: string, action: string, target?: string, value?: unknown, actor = "user"): { action?: QueuedAction; error?: string } {
    const state = this.getState(id);
    if (!state) return { error: "App not found" };

    const queued: QueuedAction = {
      id: `act_${Date.now()}_${randomBytes(4).toString("hex")}`,
      action,
      target,
      value,
      timestamp: Date.now(),
      consumed: false,
    };
    state.actionQueue.push(queued);
    if (state.actionQueue.length > MAX_ACTIONS_QUEUED) state.actionQueue = state.actionQueue.slice(-MAX_ACTIONS_QUEUED);
    state.metadata.lastAgentUpdate = Date.now();
    this.setState(id, state);

    this.writeAudit(id, actor, "action:queue", { action, target });

    return { action: queued };
  }

  consumeActions(id: string, actionIds: string[]): void {
    const state = this.getState(id);
    if (!state) return;
    const idSet = new Set(actionIds);
    for (const a of state.actionQueue) {
      if (idSet.has(a.id)) a.consumed = true;
    }
    this.setState(id, state);
  }

  getPendingActions(id: string): QueuedAction[] {
    const state = this.getState(id);
    if (!state) return [];
    return state.actionQueue.filter(a => !a.consumed);
  }

  // ── Events ──

  getEvents(id: string, since?: number): AppEvent[] {
    const p = eventsPath(id);
    if (!existsSync(p)) return [];
    try {
      const events: AppEvent[] = JSON.parse(readFileSync(p, "utf-8"));
      if (since) return events.filter(e => e.timestamp > since);
      return events;
    } catch { return []; }
  }

  pushEvent(id: string, event: Omit<AppEvent, "id" | "timestamp" | "consumed">, actor = "user"): { event?: AppEvent; error?: string } {
    // Rate limit
    if (!this.eventRateLimiter.check(`event:${id}`)) {
      return { error: "Rate limit exceeded for events" };
    }

    const full: AppEvent = {
      ...event,
      id: `evt_${Date.now()}_${randomBytes(4).toString("hex")}`,
      timestamp: Date.now(),
      consumed: false,
    };
    const events = this.getEvents(id);
    events.push(full);
    const trimmed = events.length > MAX_EVENTS_STORED ? events.slice(-MAX_EVENTS_STORED) : events;
    writeFileSync(eventsPath(id), JSON.stringify(trimmed, null, 2), "utf-8");

    const state = this.getState(id);
    if (state) {
      state.metadata.lastUserUpdate = Date.now();
      this.setState(id, state);
    }

    return { event: full };
  }

  consumeEvents(id: string, eventIds: string[]): void {
    const events = this.getEvents(id);
    const idSet = new Set(eventIds);
    for (const e of events) {
      if (idSet.has(e.id)) e.consumed = true;
    }
    writeFileSync(eventsPath(id), JSON.stringify(events, null, 2), "utf-8");
  }

  getUnconsumedEvents(id: string): AppEvent[] {
    return this.getEvents(id).filter(e => !e.consumed);
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

    this.writeAudit(appId, actor, "access:grant", { agentId, level });
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

    this.writeAudit(appId, actor, "access:revoke", { agentId });
    return { success: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function meetsAccessLevel(has: AccessLevel, needs: AccessLevel): boolean {
  const levels: Record<AccessLevel, number> = { read: 1, write: 2, admin: 3 };
  return levels[has] >= levels[needs];
}

// ── Backward compatibility ───────────────────────────────────
// Re-export types under old names so existing code doesn't break immediately

export type DashboardDefinition = AppDefinition;
export type DashboardState = AppState;
export type DashboardEvent = AppEvent;
export { AppRegistry as DashboardRegistry };

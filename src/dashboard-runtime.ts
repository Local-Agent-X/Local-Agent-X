/**
 * Dashboard Runtime — core types, registry, and instance management.
 *
 * Dashboards are structured mini-apps with a defined component model,
 * data bindings, and a programmatic API the agent can call directly.
 * The agent builds them, so it knows their internal structure.
 *
 * Persisted to ~/.sax/dashboards/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────

export type ComponentType =
  | "button" | "text" | "input" | "form" | "table" | "chart"
  | "list" | "stat" | "image" | "select" | "toggle" | "custom";

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
  handler: string;    // JS function body (runs in dashboard frontend context)
}

export interface EventDefinition {
  name: string;
  sourceComponent?: string;
  description: string;
}

export type LayoutType = "grid" | "flex" | "stack" | "tabs" | "sidebar";

export interface LayoutDefinition {
  type: LayoutType;
  columns?: number;
  gap?: string;
  areas?: string[][];
}

export interface DashboardDefinition {
  id: string;
  name: string;
  description: string;
  components: ComponentDefinition[];
  dataBindings: DataBinding[];
  actions: ActionDefinition[];
  events: EventDefinition[];
  layout: LayoutDefinition;
  standalone?: boolean;   // can run outside the app
  createdAt: number;
  updatedAt: number;
}

// ── State: server-side source of truth per dashboard ──

export interface DashboardState {
  componentValues: Record<string, unknown>;   // componentId -> current value
  actionQueue: QueuedAction[];                 // actions the agent triggered, frontend executes
  metadata: { lastAgentUpdate: number; lastUserUpdate: number };
}

export interface QueuedAction {
  id: string;
  action: string;
  target?: string;
  value?: unknown;
  timestamp: number;
  consumed: boolean;
}

export interface DashboardEvent {
  id: string;
  dashboardId: string;
  type: string;
  sourceComponent?: string;
  data: unknown;
  timestamp: number;
  consumed: boolean;
}

// ── Registry ─────────────────────────────────────────────────

const DASH_DIR = join(homedir(), ".sax", "dashboards");

function ensureDir(): void {
  if (!existsSync(DASH_DIR)) mkdirSync(DASH_DIR, { recursive: true });
}

function dashDir(id: string): string {
  return join(DASH_DIR, id);
}

function defPath(id: string): string {
  return join(dashDir(id), "definition.json");
}

function statePath(id: string): string {
  return join(dashDir(id), "state.json");
}

function eventsPath(id: string): string {
  return join(dashDir(id), "events.json");
}

export class DashboardRegistry {
  private static instance: DashboardRegistry;

  private constructor() { ensureDir(); }

  static getInstance(): DashboardRegistry {
    if (!DashboardRegistry.instance) {
      DashboardRegistry.instance = new DashboardRegistry();
    }
    return DashboardRegistry.instance;
  }

  // ── CRUD ──

  create(def: DashboardDefinition): DashboardDefinition {
    const dir = dashDir(def.id);
    mkdirSync(dir, { recursive: true });
    def.createdAt = def.createdAt || Date.now();
    def.updatedAt = Date.now();
    writeFileSync(defPath(def.id), JSON.stringify(def, null, 2), "utf-8");

    // Initialize empty state
    const state: DashboardState = {
      componentValues: {},
      actionQueue: [],
      metadata: { lastAgentUpdate: Date.now(), lastUserUpdate: 0 },
    };
    writeFileSync(statePath(def.id), JSON.stringify(state, null, 2), "utf-8");
    writeFileSync(eventsPath(def.id), "[]", "utf-8");

    return def;
  }

  get(id: string): DashboardDefinition | null {
    const p = defPath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }

  update(id: string, partial: Partial<DashboardDefinition>): DashboardDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...partial, id, updatedAt: Date.now() };
    writeFileSync(defPath(id), JSON.stringify(updated, null, 2), "utf-8");
    return updated;
  }

  delete(id: string): boolean {
    const dir = dashDir(id);
    if (!existsSync(dir)) return false;
    try { rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
  }

  list(): DashboardDefinition[] {
    ensureDir();
    const dirs = readdirSync(DASH_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    const results: DashboardDefinition[] = [];
    for (const d of dirs) {
      const def = this.get(d.name);
      if (def) results.push(def);
    }
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ── State Management ──

  getState(id: string): DashboardState | null {
    const p = statePath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }

  setState(id: string, state: DashboardState): void {
    const dir = dashDir(id);
    if (!existsSync(dir)) return;
    writeFileSync(statePath(id), JSON.stringify(state, null, 2), "utf-8");
  }

  /** Update specific component values (merge) */
  updateComponentValues(id: string, values: Record<string, unknown>): DashboardState | null {
    const state = this.getState(id);
    if (!state) return null;
    state.componentValues = { ...state.componentValues, ...values };
    state.metadata.lastAgentUpdate = Date.now();
    this.setState(id, state);
    return state;
  }

  /** Queue an action for the frontend to execute */
  queueAction(id: string, action: string, target?: string, value?: unknown): QueuedAction | null {
    const state = this.getState(id);
    if (!state) return null;
    const queued: QueuedAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action,
      target,
      value,
      timestamp: Date.now(),
      consumed: false,
    };
    state.actionQueue.push(queued);
    // Keep only last 50 actions
    if (state.actionQueue.length > 50) state.actionQueue = state.actionQueue.slice(-50);
    state.metadata.lastAgentUpdate = Date.now();
    this.setState(id, state);
    return queued;
  }

  /** Mark actions as consumed (frontend has processed them) */
  consumeActions(id: string, actionIds: string[]): void {
    const state = this.getState(id);
    if (!state) return;
    const idSet = new Set(actionIds);
    for (const a of state.actionQueue) {
      if (idSet.has(a.id)) a.consumed = true;
    }
    this.setState(id, state);
  }

  /** Get unconsumed actions */
  getPendingActions(id: string): QueuedAction[] {
    const state = this.getState(id);
    if (!state) return [];
    return state.actionQueue.filter(a => !a.consumed);
  }

  // ── Events ──

  getEvents(id: string, since?: number): DashboardEvent[] {
    const p = eventsPath(id);
    if (!existsSync(p)) return [];
    try {
      const events: DashboardEvent[] = JSON.parse(readFileSync(p, "utf-8"));
      if (since) return events.filter(e => e.timestamp > since);
      return events;
    } catch { return []; }
  }

  pushEvent(id: string, event: Omit<DashboardEvent, "id" | "timestamp" | "consumed">): DashboardEvent {
    const full: DashboardEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      consumed: false,
    };
    const events = this.getEvents(id);
    events.push(full);
    // Keep last 200 events
    const trimmed = events.length > 200 ? events.slice(-200) : events;
    writeFileSync(eventsPath(id), JSON.stringify(trimmed, null, 2), "utf-8");

    // Also update state metadata
    const state = this.getState(id);
    if (state) {
      state.metadata.lastUserUpdate = Date.now();
      this.setState(id, state);
    }

    return full;
  }

  consumeEvents(id: string, eventIds: string[]): void {
    const events = this.getEvents(id);
    const idSet = new Set(eventIds);
    for (const e of events) {
      if (idSet.has(e.id)) e.consumed = true;
    }
    writeFileSync(eventsPath(id), JSON.stringify(events, null, 2), "utf-8");
  }

  getUnconsumedEvents(id: string): DashboardEvent[] {
    return this.getEvents(id).filter(e => !e.consumed);
  }
}

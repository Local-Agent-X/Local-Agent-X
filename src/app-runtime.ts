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
 * Persisted to ~/.lax/apps/
 *
 * Composition lives in src/app-runtime/:
 *   - types.ts          — shapes + size limits + ALLOWED_COMPONENT_TYPES
 *   - validation.ts     — validateAppId / validateComponent / validateAppDefinition
 *                         + meetsAccessLevel
 *   - audit-signing.ts  — HMAC sign + verify
 *   - audit.ts          — writeAuditEntry + readAuditLog + readGlobalAuditLog
 *   - permissions.ts    — checkAccess (pure)
 *   - migration.ts      — one-time dashboards → apps migration
 *   - state-store.ts    — read/write state, component values, action queue
 *   - events-store.ts   — read/push/consume events
 *   - rate-limiter.ts   — token bucket rate limiter
 *   - paths.ts          — APPS_DIR, per-app file paths, ensureDir
 *   - registry.ts       — AppRegistry orchestrator class
 */

export type {
  AccessLevel,
  ActionDefinition,
  AppDefinition,
  AppEvent,
  AppPermissions,
  AppState,
  AppStatus,
  AppVisibility,
  AuditEntry,
  ComponentDefinition,
  ComponentType,
  DataBinding,
  EventDefinition,
  LayoutDefinition,
  LayoutType,
  QueuedAction,
} from "./app-runtime/types.js";
export { validateAppDefinition, validateAppId, validateComponent, type ValidationResult } from "./app-runtime/validation.js";
export { verifyAuditEntry } from "./app-runtime/audit-signing.js";
export { AppRegistry } from "./app-runtime/registry.js";

// ── Backward compatibility ───────────────────────────────────
// Re-export types under old names so existing code doesn't break immediately

import type { AppDefinition, AppEvent, AppState } from "./app-runtime/types.js";

export type DashboardDefinition = AppDefinition;
export type DashboardState = AppState;
export type DashboardEvent = AppEvent;
export { AppRegistry as DashboardRegistry } from "./app-runtime/registry.js";

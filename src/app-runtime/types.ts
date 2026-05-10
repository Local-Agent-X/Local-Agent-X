// ── Components ───────────────────────────────────────────────

export type ComponentType =
  | "button" | "text" | "input" | "form" | "table" | "chart"
  | "list" | "stat" | "image" | "select" | "toggle" | "custom"
  | "progress" | "alert" | "code" | "markdown" | "divider"
  | "tabs" | "accordion" | "modal" | "badge" | "avatar";

export const ALLOWED_COMPONENT_TYPES = new Set<string>([
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

// ── Size limits ──────────────────────────────────────────────

export const MAX_COMPONENTS = 200;
export const MAX_EVENTS_STORED = 500;
export const MAX_ACTIONS_QUEUED = 100;
export const MAX_STATE_SIZE_BYTES = 2 * 1024 * 1024;  // 2MB
export const MAX_APP_NAME_LENGTH = 128;
export const MAX_APP_DESC_LENGTH = 1024;
export const MAX_COMPONENT_ID_LENGTH = 64;
export const MAX_APPS_TOTAL = 500;

/**
 * Multi-User RBAC Enhancements
 *
 * Role permission matrix with fine-grained tool-level controls.
 * viewer can't use bash, operator can't change settings, etc.
 */

export type EnhancedRole = "admin" | "operator" | "user" | "viewer" | "readonly";

interface ToolPermission {
  allowed: boolean;
  reason: string;
}

interface EndpointPermission {
  methods: string[];
  allowed: boolean;
}

export interface RolePermissions {
  role: EnhancedRole;
  description: string;
  canChat: boolean;
  canManageSecrets: boolean;
  canViewAudit: boolean;
  canManageTokens: boolean;
  canChangeSettings: boolean;
  canManagePolicies: boolean;
  canExportReports: boolean;
  canManageCron: boolean;
  /** Tools this role can use. Empty = no tools. "*" in array = all tools. */
  allowedTools: string[];
  /** Tools explicitly blocked for this role (overrides allowedTools) */
  blockedTools: string[];
  /** API endpoints this role can access */
  allowedEndpoints: EndpointPermission[];
  /** Max concurrent sessions */
  maxSessions: number;
  /** Rate limit multiplier (1.0 = default, 0.5 = half rate) */
  rateLimitMultiplier: number;
}

/** The master permission matrix */
const PERMISSION_MATRIX: Record<EnhancedRole, RolePermissions> = {
  admin: {
    role: "admin",
    description: "Full system access — can manage all settings, tokens, and policies",
    canChat: true,
    canManageSecrets: true,
    canViewAudit: true,
    canManageTokens: true,
    canChangeSettings: true,
    canManagePolicies: true,
    canExportReports: true,
    canManageCron: true,
    allowedTools: ["*"],
    blockedTools: [],
    allowedEndpoints: [{ methods: ["*"], allowed: true }],
    maxSessions: 10,
    rateLimitMultiplier: 2.0,
  },

  operator: {
    role: "operator",
    description: "Operational access — can use all tools but cannot change security settings or policies",
    canChat: true,
    canManageSecrets: true,
    canViewAudit: true,
    canManageTokens: false,
    canChangeSettings: false,
    canManagePolicies: false,
    canExportReports: true,
    canManageCron: true,
    allowedTools: ["*"],
    blockedTools: [],
    allowedEndpoints: [
      { methods: ["GET", "POST"], allowed: true },
    ],
    maxSessions: 5,
    rateLimitMultiplier: 1.0,
  },

  user: {
    role: "user",
    description: "Standard user — chat and safe tools, no secrets management",
    canChat: true,
    canManageSecrets: false,
    canViewAudit: false,
    canManageTokens: false,
    canChangeSettings: false,
    canManagePolicies: false,
    canExportReports: false,
    canManageCron: false,
    allowedTools: ["read", "write", "edit", "web_fetch", "browser", "memory_search", "memory_save", "generate_image"],
    blockedTools: ["bash", "http_request", "request_secret", "request_secrets"],
    allowedEndpoints: [
      { methods: ["GET"], allowed: true },
      { methods: ["POST"], allowed: true },
    ],
    maxSessions: 3,
    rateLimitMultiplier: 1.0,
  },

  viewer: {
    role: "viewer",
    description: "Read-only chat — can view and ask questions, no tool execution",
    canChat: true,
    canManageSecrets: false,
    canViewAudit: true,
    canManageTokens: false,
    canChangeSettings: false,
    canManagePolicies: false,
    canExportReports: false,
    canManageCron: false,
    allowedTools: ["read", "memory_search"],
    blockedTools: ["bash", "write", "edit", "http_request", "web_fetch", "browser", "request_secret", "request_secrets", "generate_image"],
    allowedEndpoints: [
      { methods: ["GET"], allowed: true },
    ],
    maxSessions: 2,
    rateLimitMultiplier: 0.5,
  },

  readonly: {
    role: "readonly",
    description: "API read-only — can view sessions and health, no chat or tools",
    canChat: false,
    canManageSecrets: false,
    canViewAudit: true,
    canManageTokens: false,
    canChangeSettings: false,
    canManagePolicies: false,
    canExportReports: true,
    canManageCron: false,
    allowedTools: [],
    blockedTools: ["*"],
    allowedEndpoints: [
      { methods: ["GET"], allowed: true },
    ],
    maxSessions: 1,
    rateLimitMultiplier: 0.25,
  },
};

/** Get the permission matrix for a role */
export function getRolePermissions(role: EnhancedRole): RolePermissions {
  return PERMISSION_MATRIX[role] || PERMISSION_MATRIX.readonly;
}

/** Get the full permission matrix */
export function getPermissionMatrix(): Record<EnhancedRole, RolePermissions> {
  return { ...PERMISSION_MATRIX };
}

/** Check if a role can use a specific tool */
export function checkToolPermission(role: EnhancedRole, toolName: string): ToolPermission {
  const perms = getRolePermissions(role);

  // Check blocked tools first (override)
  if (perms.blockedTools.includes("*") || perms.blockedTools.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is blocked for role "${role}"` };
  }

  // Check allowed tools
  if (perms.allowedTools.includes("*") || perms.allowedTools.includes(toolName)) {
    return { allowed: true, reason: `Tool "${toolName}" is allowed for role "${role}"` };
  }

  // Default deny
  return { allowed: false, reason: `Tool "${toolName}" is not in the allowed list for role "${role}"` };
}

/** Check if a role can access a specific API endpoint */
export function checkEndpointPermission(role: EnhancedRole, method: string, _pathname: string): ToolPermission {
  const perms = getRolePermissions(role);

  for (const ep of perms.allowedEndpoints) {
    if (ep.methods.includes("*") || ep.methods.includes(method.toUpperCase())) {
      return { allowed: ep.allowed, reason: `${method} access ${ep.allowed ? "allowed" : "denied"} for role "${role}"` };
    }
  }

  return { allowed: false, reason: `${method} access denied for role "${role}" — no matching endpoint rule` };
}

/** Check a capability flag for a role */
export function checkCapability(
  role: EnhancedRole,
  capability: "canChat" | "canManageSecrets" | "canViewAudit" | "canManageTokens" |
    "canChangeSettings" | "canManagePolicies" | "canExportReports" | "canManageCron"
): boolean {
  return getRolePermissions(role)[capability];
}

/** Get all roles sorted by privilege level (highest first) */
export function getRoleHierarchy(): EnhancedRole[] {
  return ["admin", "operator", "user", "viewer", "readonly"];
}

/** Check if roleA has equal or higher privilege than roleB */
export function hasHigherPrivilege(roleA: EnhancedRole, roleB: EnhancedRole): boolean {
  const hierarchy = getRoleHierarchy();
  return hierarchy.indexOf(roleA) <= hierarchy.indexOf(roleB);
}

/** Get a human-readable summary of what a role can and cannot do */
export function describeRole(role: EnhancedRole): string {
  const p = getRolePermissions(role);
  const can: string[] = [];
  const cannot: string[] = [];

  if (p.canChat) can.push("chat"); else cannot.push("chat");
  if (p.canManageSecrets) can.push("manage secrets"); else cannot.push("manage secrets");
  if (p.canViewAudit) can.push("view audit logs"); else cannot.push("view audit logs");
  if (p.canManageTokens) can.push("manage tokens"); else cannot.push("manage tokens");
  if (p.canChangeSettings) can.push("change settings"); else cannot.push("change settings");
  if (p.canManagePolicies) can.push("manage policies"); else cannot.push("manage policies");
  if (p.canExportReports) can.push("export reports"); else cannot.push("export reports");
  if (p.canManageCron) can.push("manage cron"); else cannot.push("manage cron");

  const toolsDesc = p.allowedTools.includes("*")
    ? "all tools"
    : p.allowedTools.length > 0
      ? p.allowedTools.join(", ")
      : "no tools";

  return `${role}: ${p.description}\n  Can: ${can.join(", ")}\n  Cannot: ${cannot.join(", ")}\n  Tools: ${toolsDesc}` +
    (p.blockedTools.length > 0 ? `\n  Blocked: ${p.blockedTools.join(", ")}` : "");
}

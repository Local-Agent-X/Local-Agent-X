import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Basic RBAC (Role-Based Access Control)
 *
 * Replaces the single shared bearer token with scoped tokens that have
 * explicit permissions. Each token is tied to a role with defined capabilities.
 *
 * Roles:
 * - operator: Full access (all tools, secrets management, audit)
 * - user: Chat + safe tools only (no secrets management, limited shell)
 * - readonly: Read-only access (view sessions, audit logs, health)
 *
 * Tokens are stored in ~/.sax/tokens.json with hashed values.
 * The original shared token from config.json becomes the "operator" token.
 */

export type Role = "operator" | "user" | "readonly";

export interface TokenEntry {
  id: string;          // Short identifier
  name: string;        // Human label (e.g., "Peter's token", "CI token")
  role: Role;
  tokenHash: string;   // SHA-256 hash of the actual token (never store plaintext)
  createdAt: number;
  lastUsed?: number;
  expiresAt?: number;  // Optional expiry (epoch ms)
}

export interface RBACDecision {
  allowed: boolean;
  role: Role;
  reason: string;
}

// Permissions per role
const ROLE_PERMISSIONS: Record<Role, {
  canChat: boolean;
  canManageSecrets: boolean;
  canViewAudit: boolean;
  canManageTokens: boolean;
  allowedTools: string[] | "*";    // "*" = all tools
  deniedEndpoints: string[];       // API paths that are denied
}> = {
  operator: {
    canChat: true,
    canManageSecrets: true,
    canViewAudit: true,
    canManageTokens: true,
    allowedTools: "*",
    deniedEndpoints: [],
  },
  user: {
    canChat: true,
    canManageSecrets: false,
    canViewAudit: false,
    canManageTokens: false,
    allowedTools: ["read", "write", "edit", "bash", "web_fetch", "http_request", "browser", "memory_search", "memory_get", "memory_save"],
    deniedEndpoints: ["/api/secrets", "/api/audit", "/api/tokens"],
  },
  readonly: {
    canChat: false,
    canManageSecrets: false,
    canViewAudit: true,
    canManageTokens: false,
    allowedTools: [],
    deniedEndpoints: ["/api/chat", "/api/secrets"],
  },
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RBACManager {
  private tokens: Map<string, TokenEntry> = new Map();
  private filePath: string;
  private operatorTokenHash: string;

  constructor(dataDir: string, operatorToken: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "tokens.json");
    this.operatorTokenHash = hashToken(operatorToken);
    this.load();

    // Ensure operator token exists
    if (!this.findByHash(this.operatorTokenHash)) {
      this.tokens.set("operator-default", {
        id: "operator-default",
        name: "Default operator token",
        role: "operator",
        tokenHash: this.operatorTokenHash,
        createdAt: Date.now(),
      });
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as TokenEntry[];
      for (const entry of raw) {
        this.tokens.set(entry.id, entry);
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private save(): void {
    const entries = Array.from(this.tokens.values());
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  private findByHash(hash: string): TokenEntry | undefined {
    for (const entry of this.tokens.values()) {
      if (entry.tokenHash === hash) return entry;
    }
    return undefined;
  }

  /** Authenticate a bearer token and return the role. Timing-safe. */
  authenticate(bearerToken: string): { valid: boolean; entry?: TokenEntry } {
    const incomingHash = hashToken(bearerToken);

    for (const entry of this.tokens.values()) {
      // Timing-safe comparison of hashes
      const a = Buffer.from(incomingHash);
      const b = Buffer.from(entry.tokenHash);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        // Check expiry
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
          return { valid: false };
        }
        // Update last used
        entry.lastUsed = Date.now();
        this.save();
        return { valid: true, entry };
      }
    }
    return { valid: false };
  }

  /** Check if a role is allowed to access an API endpoint */
  checkEndpoint(role: Role, method: string, pathname: string): RBACDecision {
    const perms = ROLE_PERMISSIONS[role];

    // Check denied endpoints
    for (const denied of perms.deniedEndpoints) {
      if (pathname.startsWith(denied)) {
        return { allowed: false, role, reason: `Role "${role}" cannot access ${pathname}` };
      }
    }

    // Check chat permission for POST /api/chat
    if (pathname === "/api/chat" && method === "POST" && !perms.canChat) {
      return { allowed: false, role, reason: `Role "${role}" cannot send chat messages` };
    }

    return { allowed: true, role, reason: "Endpoint allowed" };
  }

  /** Check if a role is allowed to use a specific tool */
  checkTool(role: Role, toolName: string): RBACDecision {
    const perms = ROLE_PERMISSIONS[role];
    if (perms.allowedTools === "*") {
      return { allowed: true, role, reason: "Operator: all tools allowed" };
    }
    if (perms.allowedTools.includes(toolName)) {
      return { allowed: true, role, reason: `Tool "${toolName}" allowed for role "${role}"` };
    }
    return { allowed: false, role, reason: `Role "${role}" cannot use tool "${toolName}"` };
  }

  /** Create a new scoped token. Returns the raw token (show once). */
  createToken(name: string, role: Role, expiresInMs?: number): { token: string; entry: TokenEntry } {
    const token = randomBytes(32).toString("hex");
    const id = `token-${randomBytes(4).toString("hex")}`;
    const entry: TokenEntry = {
      id,
      name,
      role,
      tokenHash: hashToken(token),
      createdAt: Date.now(),
      expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
    };
    this.tokens.set(id, entry);
    this.save();
    return { token, entry };
  }

  /** Revoke a token by ID */
  revokeToken(id: string): boolean {
    const existed = this.tokens.delete(id);
    if (existed) this.save();
    return existed;
  }

  /** List all tokens (never exposes hashes) */
  listTokens(): Array<Omit<TokenEntry, "tokenHash">> {
    return Array.from(this.tokens.values()).map(({ tokenHash, ...rest }) => rest);
  }

  /** Get permissions for a role */
  static getPermissions(role: Role) {
    return ROLE_PERMISSIONS[role];
  }
}

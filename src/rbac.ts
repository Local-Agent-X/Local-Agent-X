import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { USER_HINTS } from "./types.js";

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
 * - agent: In-process agent self-call principal — chat + benign self-calls,
 *   but denied every sensitive sink (secrets, tokens, plugins, auth, audit, logs)
 *
 * Tokens are stored in ~/.lax/tokens.json with hashed values.
 * The original shared token from config.json becomes the "operator" token.
 */

export type Role = "operator" | "user" | "readonly" | "agent";

export interface TokenEntry {
  id: string;          // Short identifier
  name: string;        // Human label (e.g., "Laptop token", "CI token")
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
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  userHint?: string;
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
    // No egress tools, no secrets, no browser — operator only
    // Users can read/write local files and use memory, but can't send data externally
    // bash is allowed but SecurityLayer blocks network tools within it
    allowedTools: ["read", "write", "edit", "bash", "memory_search", "memory_get", "memory_save", "memory_recall", "memory_reflect", "memory_update_profile", "memory_stats"],
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
  agent: {
    canChat: true,
    canManageSecrets: false,
    canViewAudit: false,
    canManageTokens: false,
    // HTTP endpoint gating is the control here; tool dispatch is governed
    // elsewhere, so "*" keeps the agent loop's benign self-calls working.
    allowedTools: "*",
    // Deny every sensitive sink reachable over HTTP. Benign self-calls
    // (/api/settings, theme, orgs) are not under any of these prefixes.
    deniedEndpoints: ["/api/secrets", "/api/tokens", "/api/plugins", "/api/auth", "/api/audit", "/api/logs"],
  },
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RBACManager {
  private tokens: Map<string, TokenEntry> = new Map();
  private filePath: string;
  private operatorTokenHash: string;
  private authCallCount = 0;
  private internalAgentToken: string;
  // Ephemeral per-process entry for the in-process agent self-call principal.
  // Deliberately kept OUT of `this.tokens` so it is never persisted by save().
  private internalAgentEntry: TokenEntry;

  constructor(dataDir: string, operatorToken: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, "tokens.json");
    this.operatorTokenHash = hashToken(operatorToken);
    this.load();

    // Ensure operator token exists — clear stale operator entries to prevent duplication
    const existingOp = this.findByHash(this.operatorTokenHash);
    if (!existingOp) {
      // Remove any previous operator-default entries (prevents duplication on token change)
      if (this.tokens.has("operator-default")) {
        this.tokens.delete("operator-default");
      }
      const TOKEN_EXPIRY_DAYS = 90;
      this.tokens.set("operator-default", {
        id: "operator-default",
        name: "Default operator token",
        role: "operator",
        tokenHash: this.operatorTokenHash,
        createdAt: Date.now(),
        expiresAt: Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      });
      this.save();
    }

    // Mint a per-process ephemeral internal token for the in-process agent's
    // own self-calls. Never persisted — lives only as a private field for the
    // lifetime of this process.
    const token = randomBytes(32).toString("hex");
    this.internalAgentToken = token;
    this.internalAgentEntry = {
      id: "internal-agent",
      name: "In-process agent self-call",
      role: "agent",
      tokenHash: hashToken(token),
      createdAt: Date.now(),
    };
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
    // Auto-prune expired tokens periodically (every 100 auth calls)
    if (++this.authCallCount % 100 === 0) this.pruneExpired();

    const incomingHash = hashToken(bearerToken);

    // Ephemeral in-process agent token: timing-safe match, never persisted.
    {
      const a = Buffer.from(incomingHash);
      const b = Buffer.from(this.internalAgentEntry.tokenHash);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { valid: true, entry: this.internalAgentEntry };
      }
    }

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

    // Check denied endpoints — exact match or path prefix (with / boundary)
    for (const denied of perms.deniedEndpoints) {
      if (pathname === denied || pathname.startsWith(denied + "/")) {
        return { allowed: false, role, reason: `Role "${role}" cannot access ${pathname}`, userHint: USER_HINTS.policy };
      }
    }

    // Check chat permission for POST /api/chat
    if (pathname === "/api/chat" && method === "POST" && !perms.canChat) {
      return { allowed: false, role, reason: `Role "${role}" cannot send chat messages`, userHint: USER_HINTS.policy };
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
    return { allowed: false, role, reason: `Role "${role}" cannot use tool "${toolName}"`, userHint: USER_HINTS.policy };
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

  /** Raw per-process internal agent token (for wiring into the agent's self-calls). */
  getInternalAgentToken(): string {
    return this.internalAgentToken;
  }

  /** Rotate the operator token in place. Re-hashes the operator-default entry
   *  and updates operatorTokenHash. Leaves the per-process internal agent token
   *  untouched (it is unrelated to the operator credential). */
  rotateOperatorToken(newToken: string): void {
    this.operatorTokenHash = hashToken(newToken);
    const TOKEN_EXPIRY_DAYS = 90;
    const existing = this.tokens.get("operator-default");
    if (existing) {
      existing.tokenHash = this.operatorTokenHash;
      existing.createdAt = Date.now();
      existing.lastUsed = undefined;
      existing.expiresAt = Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    } else {
      this.tokens.set("operator-default", {
        id: "operator-default",
        name: "Default operator token",
        role: "operator",
        tokenHash: this.operatorTokenHash,
        createdAt: Date.now(),
        expiresAt: Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      });
    }
    this.save();
  }

  /**
   * Rotate a token: revoke the old one and issue a new one with the same role/name.
   * Returns the new raw token (show once to the user).
   */
  rotateToken(id: string): { token: string; entry: TokenEntry } | null {
    const old = this.tokens.get(id);
    if (!old) return null;

    // Don't allow rotating the default operator token (it comes from config)
    if (id === "operator-default") {
      // Generate a new operator token and replace
      const newToken = randomBytes(32).toString("hex");
      old.tokenHash = hashToken(newToken);
      old.createdAt = Date.now();
      old.lastUsed = undefined;
      this.save();
      return { token: newToken, entry: old };
    }

    // For other tokens: revoke old, create new with same role/name
    // Preserve the original absolute expiry time (not shrinking relative window)
    const role = old.role;
    const name = old.name;
    const originalExpiresAt = old.expiresAt;
    this.tokens.delete(id);
    const result = this.createToken(name, role);
    // Restore original absolute expiry if set
    if (originalExpiresAt && originalExpiresAt > Date.now()) {
      result.entry.expiresAt = originalExpiresAt;
      this.save();
    }
    return result;
  }

  /** Prune all expired tokens */
  pruneExpired(): number {
    let pruned = 0;
    const now = Date.now();
    for (const [id, entry] of this.tokens) {
      if (entry.expiresAt && entry.expiresAt < now && id !== "operator-default") {
        this.tokens.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }
}

// Module-level holder for the per-process internal agent token. Set at server
// boot from the RBACManager instance so tool code (which isn't wired with the
// manager) can read the token without re-threading it. Same pattern as
// getSecretsStoreSingleton() in secrets.ts.
let _internalAgentToken: string | null = null;
export function setInternalAgentToken(t: string): void {
  _internalAgentToken = t;
}
export function getInternalAgentToken(): string | null {
  return _internalAgentToken;
}

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { RBACManager } from "../src/rbac.js";

// ── RBAC: pruneExpired drops expired tokens, keeps fresh + operator-default ──

describe("RBACManager.pruneExpired", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // Pin the clock so token expiry windows are fully deterministic.
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes an expired token and keeps a fresh one, returning the prune count", () => {
    const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

    // Created at NOW, expires 1s later.
    const expired = rbac.createToken("expired", "user", 1_000);
    // Created at NOW, expires far in the future.
    const fresh = rbac.createToken("fresh", "user", 10 * 24 * 60 * 60 * 1000);

    // Advance the clock past the short token's expiry but not the long one's.
    vi.setSystemTime(NOW + 5_000);

    const pruned = rbac.pruneExpired();
    expect(pruned).toBe(1);

    const ids = rbac.listTokens().map((e) => e.id);
    expect(ids).not.toContain(expired.entry.id);
    expect(ids).toContain(fresh.entry.id);
  });

  it("never prunes the operator-default entry even when its expiresAt is in the past", () => {
    const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

    // operator-default is minted with a ~90-day expiry. Jump well past it.
    vi.setSystemTime(NOW + 365 * 24 * 60 * 60 * 1000);

    rbac.pruneExpired();
    expect(rbac.listTokens().some((e) => e.id === "operator-default")).toBe(true);
  });

  it("treats a token with no expiresAt as never-expiring", () => {
    const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

    // No expiry argument => expiresAt is undefined.
    const perpetual = rbac.createToken("perpetual", "user");

    vi.setSystemTime(NOW + 1000 * 24 * 60 * 60 * 1000);

    expect(rbac.pruneExpired()).toBe(0);
    expect(rbac.listTokens().some((e) => e.id === perpetual.entry.id)).toBe(true);
  });

  it("returns 0 and prunes nothing when all tokens are still fresh", () => {
    const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));
    rbac.createToken("a", "user", 60 * 60 * 1000);
    rbac.createToken("b", "readonly", 60 * 60 * 1000);

    expect(rbac.pruneExpired()).toBe(0);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

// ── RBAC: checkEndpoint path-prefix matching (exact + subtree, / boundary) ──

describe("RBACManager.checkEndpoint path-prefix matching", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-endpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

  // The "user" role denies ["/api/secrets", "/api/audit", "/api/tokens"].

  it("denies an EXACT match of a denied prefix", () => {
    expect(rbac.checkEndpoint("user", "GET", "/api/secrets").allowed).toBe(false);
    expect(rbac.checkEndpoint("user", "GET", "/api/tokens").allowed).toBe(false);
  });

  it("denies a SUBTREE path under a denied prefix (boundary is '/')", () => {
    expect(rbac.checkEndpoint("user", "GET", "/api/secrets/x/reveal").allowed).toBe(false);
    expect(rbac.checkEndpoint("user", "POST", "/api/tokens/create").allowed).toBe(false);
  });

  it("does NOT deny a sibling path that merely shares the prefix as a substring", () => {
    // The classic false-positive: "/api/admin" must not match "/api/admins".
    // Here "/api/secrets" must not swallow "/api/secretsx" or "/api/secrets-export".
    expect(rbac.checkEndpoint("user", "GET", "/api/secretsx").allowed).toBe(true);
    expect(rbac.checkEndpoint("user", "GET", "/api/secrets-export").allowed).toBe(true);
    expect(rbac.checkEndpoint("user", "GET", "/api/tokensX").allowed).toBe(true);
  });

  it("allows unrelated endpoints for a restricted role", () => {
    expect(rbac.checkEndpoint("user", "GET", "/api/settings").allowed).toBe(true);
    expect(rbac.checkEndpoint("user", "GET", "/api/sessions").allowed).toBe(true);
  });

  it("denies the POST /api/chat endpoint for a role that cannot chat", () => {
    // readonly: canChat=false and /api/chat is in its deniedEndpoints.
    const decision = rbac.checkEndpoint("readonly", "POST", "/api/chat");
    expect(decision.allowed).toBe(false);
  });

  it("allows POST /api/chat for a role that can chat and is not denied it", () => {
    expect(rbac.checkEndpoint("user", "POST", "/api/chat").allowed).toBe(true);
  });

  it("attaches a userHint when denying by policy", () => {
    const decision = rbac.checkEndpoint("user", "GET", "/api/secrets");
    expect(decision.allowed).toBe(false);
    expect(decision.userHint).toBeDefined();
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

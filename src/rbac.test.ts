import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { RBACManager } from "./rbac.js";

// ── RBAC: least-privilege "agent" role + per-process internal token ──

describe("RBAC agent role", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

  it("agent role is DENIED the sensitive sinks", () => {
    expect(rbac.checkEndpoint("agent", "GET", "/api/secrets/x/reveal").allowed).toBe(false);
    expect(rbac.checkEndpoint("agent", "POST", "/api/plugins/load").allowed).toBe(false);
    expect(rbac.checkEndpoint("agent", "POST", "/api/auth/rotate").allowed).toBe(false);
  });

  it("agent role CAN make benign self-calls", () => {
    expect(rbac.checkEndpoint("agent", "GET", "/api/settings").allowed).toBe(true);
  });

  it("internal agent token authenticates as the agent role", () => {
    const result = rbac.authenticate(rbac.getInternalAgentToken());
    expect(result.valid).toBe(true);
    expect(result.entry?.role).toBe("agent");
  });

  it("internal agent token is NEVER persisted to tokens.json", () => {
    // Force a save by minting a real token, then assert the internal entry is absent.
    rbac.createToken("dummy", "user");
    const file = join(tmpDir, "tokens.json");
    expect(existsSync(file)).toBe(true);
    const persisted = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string }>;
    expect(persisted.some((e) => e.id === "internal-agent")).toBe(false);
    expect(rbac.listTokens().some((e) => e.id === "internal-agent")).toBe(false);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

// ── RBAC: rotateOperatorToken leaves the internal agent token untouched ──

describe("RBAC rotateOperatorToken", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-rotate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const oldToken = randomBytes(32).toString("hex");
  const newToken = randomBytes(32).toString("hex");
  const rbac = new RBACManager(tmpDir, oldToken);
  const internalBefore = rbac.getInternalAgentToken();

  rbac.rotateOperatorToken(newToken);

  it("authenticates the NEW operator token after rotation", () => {
    const result = rbac.authenticate(newToken);
    expect(result.valid).toBe(true);
    expect(result.entry?.role).toBe("operator");
  });

  it("rejects the OLD operator token after rotation", () => {
    expect(rbac.authenticate(oldToken).valid).toBe(false);
  });

  it("leaves the per-process internal agent token unchanged", () => {
    expect(rbac.getInternalAgentToken()).toBe(internalBefore);
  });

  it("internal agent token still authenticates as the agent role after rotation", () => {
    const result = rbac.authenticate(rbac.getInternalAgentToken());
    expect(result.valid).toBe(true);
    expect(result.entry?.role).toBe("agent");
  });

  it("refreshes the operator-default entry's expiresAt to a full ~90-day window", () => {
    const entry = rbac.listTokens().find((e) => e.id === "operator-default");
    expect(entry).toBeDefined();
    // A rotated credential must reset its full lifetime, not keep the old window.
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1000);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

// ── RBAC: rotating a near-expiry operator credential resets its lifetime ──

describe("RBAC rotateOperatorToken refreshes a near-expiry window", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-rotate-expiry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const oldToken = randomBytes(32).toString("hex");
  const newToken = randomBytes(32).toString("hex");

  // First instance seeds tokens.json with the operator-default entry.
  new RBACManager(tmpDir, oldToken);
  const file = join(tmpDir, "tokens.json");
  // Force the persisted operator-default entry into a near-expiry window.
  const nearExpiry = Date.now() + 24 * 60 * 60 * 1000; // ~1 day left
  const persisted = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; expiresAt?: number }>;
  for (const e of persisted) {
    if (e.id === "operator-default") e.expiresAt = nearExpiry;
  }
  writeFileSync(file, JSON.stringify(persisted));

  // Reload from disk so the manager carries the short-lived entry, then rotate.
  const rbac = new RBACManager(tmpDir, oldToken);
  rbac.rotateOperatorToken(newToken);

  it("resets expiresAt to a full ~90-day window, discarding the near-expiry one", () => {
    const entry = rbac.listTokens().find((e) => e.id === "operator-default");
    expect(entry).toBeDefined();
    expect(entry!.expiresAt).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1000);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

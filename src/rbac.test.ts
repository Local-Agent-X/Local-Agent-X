import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { RBACManager } from "./rbac.js";
import { authorizeUpgrade } from "./server/ws-operator-auth.js";

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

  // C7 round-2: /api/local-runtimes is egress-granting — a POST/DELETE there
  // rewrites settings.localRuntimes, and every entry becomes an exact host:port
  // the agent's own HTTP tools may reach (security-config manualRuntimeHostPorts
  // → evaluateWebFetch carve-out). It MUST be denied to the agent self-call
  // principal or the fold becomes an agent-controlled egress allowlist. This is
  // the linchpin the whole attack chain dies on.
  it("agent role is DENIED /api/local-runtimes for the mutating methods (egress-granting)", () => {
    expect(rbac.checkEndpoint("agent", "POST", "/api/local-runtimes").allowed).toBe(false);
    expect(rbac.checkEndpoint("agent", "DELETE", "/api/local-runtimes").allowed).toBe(false);
    expect(rbac.checkEndpoint("agent", "PUT", "/api/local-runtimes").allowed).toBe(false);
  });

  it("agent role is DENIED /api/local-runtimes for GET too (path-only denial; agent never needs it)", () => {
    // deniedEndpoints carries no method scoping, so the read-only GET is denied
    // by the same path entry — the agent reads runtimes from the in-process
    // cache, not this route, so nothing legitimate breaks.
    expect(rbac.checkEndpoint("agent", "GET", "/api/local-runtimes").allowed).toBe(false);
    // Prefix boundary: subpaths are denied, siblings are not falsely swept in.
    expect(rbac.checkEndpoint("agent", "GET", "/api/local-runtimes/anything").allowed).toBe(false);
    expect(rbac.checkEndpoint("agent", "GET", "/api/local-runtimes-sibling").allowed).toBe(true);
  });

  it("operator role CAN reach /api/local-runtimes (the settings UI path is unaffected)", () => {
    expect(rbac.checkEndpoint("operator", "POST", "/api/local-runtimes").allowed).toBe(true);
    expect(rbac.checkEndpoint("operator", "DELETE", "/api/local-runtimes").allowed).toBe(true);
    expect(rbac.checkEndpoint("operator", "GET", "/api/local-runtimes").allowed).toBe(true);
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

  it("leaves the operator-default entry without an expiry after rotation", () => {
    const entry = rbac.listTokens().find((e) => e.id === "operator-default");
    expect(entry).toBeDefined();
    expect(entry!.expiresAt).toBeUndefined();
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

// ── RBAC: the operator credential never expires (the 2026-09-30 cliff) ──
//
// The operator token is the app's own identity; the UI loads with it and
// nothing rotates it on a schedule. It used to be minted with a 90-day window,
// so 90 days after first boot every REST call from the UI 401'd while chat
// (WS upgrade, no expiry) kept working, and a restart left the expired entry
// as found. These pin: an already-expired entry from such a build heals on
// load, the credential stays valid indefinitely, REST and WS agree, and
// tokens issued with an expiry still expire.

describe("RBAC operator credential never expires", () => {
  const tmpDir = join(tmpdir(), `lax-rbac-cliff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const DAY = 24 * 60 * 60 * 1000;

  // A tokens.json as a pre-fix build left it on a 91-day-old install: the
  // operator entry present, its window already past.
  new RBACManager(tmpDir, token);
  const file = join(tmpDir, "tokens.json");
  const persisted = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; expiresAt?: number }>;
  for (const e of persisted) if (e.id === "operator-default") e.expiresAt = Date.now() - DAY;
  writeFileSync(file, JSON.stringify(persisted));

  const rbac = new RBACManager(tmpDir, token);

  afterEach(() => vi.useRealTimers());

  it("an operator entry persisted with a past expiry authenticates after load (the 401 every UI call hit)", () => {
    const r = rbac.authenticate(token);
    expect(r.valid).toBe(true);
    expect(r.entry?.role).toBe("operator");
  });

  it("heals the persisted entry: no expiry in memory or on disk", () => {
    expect(rbac.listTokens().find((e) => e.id === "operator-default")!.expiresAt).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; expiresAt?: number }>;
    expect(onDisk.find((e) => e.id === "operator-default")!.expiresAt).toBeUndefined();
  });

  it("stays valid indefinitely, and REST agrees with the WS upgrade rule", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 400 * DAY);
    expect(rbac.authenticate(token).valid).toBe(true);
    expect(authorizeUpgrade(token, token).ok).toBe(true);
  });

  it("a token issued WITH an expiry still expires — the control is per issued token, not gone", () => {
    const issued = rbac.createToken("short-lived", "operator", DAY);
    expect(rbac.authenticate(issued.token).valid).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * DAY);
    expect(rbac.authenticate(issued.token).valid).toBe(false);
    expect(rbac.authenticate(token).valid, "the operator credential is unaffected").toBe(true);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

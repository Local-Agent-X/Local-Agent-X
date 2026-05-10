import { describe, it, expect } from "vitest";
import { signAuditEntry, verifyAuditEntry } from "../src/app-runtime/audit-signing.js";
import type { AuditEntry } from "../src/app-runtime/types.js";

const baseEntry = (over: Partial<Omit<AuditEntry, "signature">> = {}): Omit<AuditEntry, "signature"> => ({
  id: "aud_1",
  timestamp: 1700000000000,
  actor: "user",
  action: "app:create",
  appId: "app1",
  details: {},
  ...over,
});

describe("signAuditEntry", () => {
  it("returns a 16-char hex string", () => {
    const sig = signAuditEntry(baseEntry());
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same input within a process", () => {
    const e = baseEntry();
    expect(signAuditEntry(e)).toBe(signAuditEntry(e));
  });

  it("changes when the action changes", () => {
    expect(signAuditEntry(baseEntry({ action: "app:create" })))
      .not.toBe(signAuditEntry(baseEntry({ action: "app:delete" })));
  });

  it("changes when the actor changes", () => {
    expect(signAuditEntry(baseEntry({ actor: "user" })))
      .not.toBe(signAuditEntry(baseEntry({ actor: "agent-x" })));
  });

  it("changes when the appId changes", () => {
    expect(signAuditEntry(baseEntry({ appId: "a" })))
      .not.toBe(signAuditEntry(baseEntry({ appId: "b" })));
  });

  it("changes when the timestamp changes", () => {
    expect(signAuditEntry(baseEntry({ timestamp: 1 })))
      .not.toBe(signAuditEntry(baseEntry({ timestamp: 2 })));
  });
});

describe("verifyAuditEntry", () => {
  it("returns true for a freshly signed entry", () => {
    const e = baseEntry();
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    expect(verifyAuditEntry(signed)).toBe(true);
  });

  it("returns false when the action was tampered with", () => {
    const e = baseEntry({ action: "app:create" });
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    const tampered: AuditEntry = { ...signed, action: "app:delete" };
    expect(verifyAuditEntry(tampered)).toBe(false);
  });

  it("returns false when the actor was tampered with (privilege escalation attempt)", () => {
    const e = baseEntry({ actor: "user" });
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    const tampered: AuditEntry = { ...signed, actor: "system" };
    expect(verifyAuditEntry(tampered)).toBe(false);
  });

  it("returns false when the signature is empty or wrong", () => {
    const e = baseEntry();
    expect(verifyAuditEntry({ ...e, signature: "" })).toBe(false);
    expect(verifyAuditEntry({ ...e, signature: "0".repeat(16) })).toBe(false);
  });
});

/**
 * Layer C — persistent trust ledger. Tests cover the fingerprint
 * extraction, the record/check contract, and persistence across
 * cache resets. Per-file isolated by point-in-time temp ledger path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trust ledger writes to ~/.lax/threat-trust-ledger.json. Override HOME
// for these tests so we don't clobber real state.
let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "trust-ledger-test-"));
  origHome = process.env.HOME ?? process.env.USERPROFILE;
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
});

afterEach(async () => {
  if (origHome) {
    process.env.USERPROFILE = origHome;
    process.env.HOME = origHome;
  }
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  // Drop the module cache so the next test gets a fresh load against the new HOME
  const mod = await import("../src/threat/trust-ledger.js");
  mod._resetLedgerCacheForTests();
});

describe("fingerprintOf", () => {
  it("builds <sourceType>:<hostname> for URL sinks", async () => {
    const { fingerprintOf } = await import("../src/threat/trust-ledger.js");
    expect(fingerprintOf("shell", "https://cloud.thrivemetrics.com/po/new")).toBe("shell:cloud.thrivemetrics.com");
    expect(fingerprintOf("file_read", "https://api.x.ai/v1/messages")).toBe("file_read:api.x.ai");
  });

  it("lowercases the hostname", async () => {
    const { fingerprintOf } = await import("../src/threat/trust-ledger.js");
    expect(fingerprintOf("shell", "https://Cloud.Thrivemetrics.COM/x")).toBe("shell:cloud.thrivemetrics.com");
  });

  it("returns null when sink is not a URL (can't build learnable pattern)", async () => {
    const { fingerprintOf } = await import("../src/threat/trust-ledger.js");
    expect(fingerprintOf("shell", "click_button")).toBeNull();
    expect(fingerprintOf("shell", "")).toBeNull();
  });

  it("returns null when sourceType is empty", async () => {
    const { fingerprintOf } = await import("../src/threat/trust-ledger.js");
    expect(fingerprintOf("", "https://x.com")).toBeNull();
  });
});

describe("recordApproval + isLearned", () => {
  it("isLearned returns false before any approval", async () => {
    const { isLearned } = await import("../src/threat/trust-ledger.js");
    expect(isLearned("shell:cloud.thrivemetrics.com")).toBe(false);
  });

  it("isLearned returns true after recordApproval", async () => {
    const { recordApproval, isLearned } = await import("../src/threat/trust-ledger.js");
    recordApproval("shell:cloud.thrivemetrics.com", "first approval");
    expect(isLearned("shell:cloud.thrivemetrics.com")).toBe(true);
  });

  it("re-recording the same pattern bumps approvals count", async () => {
    const { recordApproval, listLearned } = await import("../src/threat/trust-ledger.js");
    recordApproval("shell:x.com", "first");
    recordApproval("shell:x.com", "second");
    const list = listLearned();
    const entry = list.find(p => p.fingerprint === "shell:x.com");
    expect(entry?.approvals).toBe(2);
    expect(entry?.reason).toBe("second");
  });

  it("persists to disk and survives cache reset", async () => {
    const ledger = await import("../src/threat/trust-ledger.js");
    ledger.recordApproval("shell:persisted.example.com", "persist-test");
    expect(ledger.isLearned("shell:persisted.example.com")).toBe(true);
    // Force a fresh load from disk
    ledger._resetLedgerCacheForTests();
    expect(ledger.isLearned("shell:persisted.example.com")).toBe(true);
  });

  it("forget removes a learned pattern", async () => {
    const { recordApproval, forget, isLearned } = await import("../src/threat/trust-ledger.js");
    recordApproval("shell:throwaway.com", "test");
    expect(forget("shell:throwaway.com")).toBe(true);
    expect(isLearned("shell:throwaway.com")).toBe(false);
    expect(forget("never-existed")).toBe(false);
  });
});

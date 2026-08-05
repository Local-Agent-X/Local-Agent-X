import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), "lax-trust-ttl-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const ledger = await import("./trust-ledger.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ledger._resetLedgerCacheForTests();
  rmSync(join(home, ".lax"), { recursive: true, force: true });
});

afterAll(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe("trust-ledger 30-day TTL", () => {
  it("a fresh grant is learned and stays learned up to the TTL boundary", () => {
    ledger.recordApproval("shell:example.com", "ok");
    expect(ledger.isLearned("shell:example.com")).toBe(true);
    vi.setSystemTime(T0 + ledger.TRUST_TTL_MS);
    expect(ledger.isLearned("shell:example.com")).toBe(true);
  });

  it("a grant older than the TTL is no longer learned, even with a warm cache", () => {
    ledger.recordApproval("shell:example.com", "ok");
    vi.setSystemTime(T0 + ledger.TRUST_TTL_MS + 1);
    expect(ledger.isLearned("shell:example.com")).toBe(false);
    expect(ledger.listLearned()).toEqual([]);
  });

  it("re-approval refreshes the TTL from the latest approval", () => {
    ledger.recordApproval("shell:example.com", "ok");
    vi.setSystemTime(T0 + 20 * DAY);
    ledger.recordApproval("shell:example.com", "still ok");
    vi.setSystemTime(T0 + 45 * DAY);
    expect(ledger.isLearned("shell:example.com")).toBe(true);
    vi.setSystemTime(T0 + 51 * DAY);
    expect(ledger.isLearned("shell:example.com")).toBe(false);
  });

  it("expired grants are pruned on reload; a later re-approval starts a fresh grant", () => {
    ledger.recordApproval("shell:old.example.com", "ok");
    ledger.recordApproval("shell:fresh.example.com", "ok");
    vi.setSystemTime(T0 + 31 * DAY);
    ledger.recordApproval("shell:fresh.example.com", "ok again");
    ledger._resetLedgerCacheForTests();
    expect(ledger.listLearned().map((p) => p.fingerprint)).toEqual(["shell:fresh.example.com"]);
    ledger.recordApproval("shell:old.example.com", "back again");
    expect(ledger.listLearned()).toHaveLength(2);
    expect(ledger.listLearned().find((p) => p.fingerprint === "shell:old.example.com")?.approvals).toBe(1);
  });
});

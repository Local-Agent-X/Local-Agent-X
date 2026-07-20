import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), "lax-approval-once-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const consent = await import("./consent-store.js");
const ledger = await import("./trust-ledger.js");

beforeEach(() => {
  consent._resetAllConsentForTests();
  ledger._resetLedgerCacheForTests();
});

afterAll(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe("ingress-keyed approval", () => {
  it("does not extend the consent window when the same delivery is replayed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    consent.grantConsentOnce("receipt-1", "session", 1_000, "ok");
    vi.setSystemTime(1_500);
    consent.grantConsentOnce("receipt-1", "session", 1_000, "ok");
    expect(consent.getActiveConsent("session")?.remainingMs).toBe(500);
  });

  it("increments the trust ledger once per distinct delivery", () => {
    ledger.recordApprovalOnce("receipt-1", "shell:example.com", "ok");
    ledger.recordApprovalOnce("receipt-1", "shell:example.com", "ok");
    ledger.recordApprovalOnce("receipt-2", "shell:example.com", "ok again");
    expect(ledger.listLearned()[0]).toMatchObject({ approvals: 2, approvalKeys: ["receipt-1", "receipt-2"] });
  });
});

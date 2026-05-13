/**
 * Layer B — session-level consent store used by /approve recovery
 * AND by Layer A's attachment-with-directive auto-grant. Verifies
 * isolation, expiry, and the per-session contract.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  grantConsent,
  getActiveConsent,
  clearConsent,
  _resetAllConsentForTests,
} from "../src/threat/consent-store.js";

beforeEach(() => { _resetAllConsentForTests(); });

describe("consent-store", () => {
  it("returns null when no consent granted", () => {
    expect(getActiveConsent("sess-1")).toBeNull();
  });

  it("returns the consent inside the window", () => {
    grantConsent("sess-1", 5 * 60_000, "test-grant");
    const c = getActiveConsent("sess-1");
    expect(c).not.toBeNull();
    expect(c!.reason).toBe("test-grant");
    expect(c!.remainingMs).toBeGreaterThan(4 * 60_000);
  });

  it("returns null after expiry and self-cleans the map", () => {
    grantConsent("sess-1", 1, "test-expired");
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(getActiveConsent("sess-1")).toBeNull();
      // Re-checking should still be null (consistent), not flap
      expect(getActiveConsent("sess-1")).toBeNull();
      resolve();
    }, 10));
  });

  it("isolates sessions", () => {
    grantConsent("sess-a", 60_000, "for-a");
    expect(getActiveConsent("sess-a")?.reason).toBe("for-a");
    expect(getActiveConsent("sess-b")).toBeNull();
  });

  it("clearConsent removes only the named session", () => {
    grantConsent("sess-a", 60_000, "a");
    grantConsent("sess-b", 60_000, "b");
    clearConsent("sess-a");
    expect(getActiveConsent("sess-a")).toBeNull();
    expect(getActiveConsent("sess-b")?.reason).toBe("b");
  });

  it("re-granting extends the window with the new reason", () => {
    grantConsent("sess-1", 1, "first");
    grantConsent("sess-1", 60_000, "second");
    const c = getActiveConsent("sess-1");
    expect(c?.reason).toBe("second");
    expect(c!.remainingMs).toBeGreaterThan(50_000);
  });
});

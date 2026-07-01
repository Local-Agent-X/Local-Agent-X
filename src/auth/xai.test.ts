// Refresh-timing policy for xAI OAuth tokens. Locks the intent that we proactively
// refresh ~1h before the real expiry (not the old ~minutes-before window), and that
// the skew is applied ONCE — expiresAt holds the REAL expiry, so isXaiTokenExpired
// and shouldRefreshXaiToken don't double-count it.

import { describe, it, expect } from "vitest";
import { shouldRefreshXaiToken, isXaiTokenExpired, type XaiTokens } from "./xai.js";

function tok(expiresInMs: number | undefined): XaiTokens {
  return {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: expiresInMs === undefined ? undefined : Date.now() + expiresInMs,
    provider: "xai",
  };
}

describe("xAI token refresh timing", () => {
  it("refreshes ~1h before expiry, not just minutes before (regression guard)", () => {
    // 30 min of life left is inside the 1h window → due for refresh. Under the old
    // ~2-4 min window this was FALSE; that gap is what stranded long-idle callers.
    expect(shouldRefreshXaiToken(tok(30 * 60 * 1000))).toBe(true);
  });

  it("leaves a token with plenty of life alone", () => {
    expect(shouldRefreshXaiToken(tok(2 * 60 * 60 * 1000))).toBe(false);
  });

  it("refreshes an already-expired token", () => {
    expect(shouldRefreshXaiToken(tok(-60 * 1000))).toBe(true);
  });

  it("does not force a refresh when expiry is unknown or there is no token", () => {
    expect(shouldRefreshXaiToken(tok(undefined))).toBe(false);
    expect(shouldRefreshXaiToken(null)).toBe(false);
  });

  it("isXaiTokenExpired reflects REAL expiry, so the skew is applied only once", () => {
    // Inside the refresh window but not actually expired → refresh due, NOT expired.
    // If the skew were still double-counted, expiresAt would already be shifted and
    // this invariant would drift.
    expect(shouldRefreshXaiToken(tok(30 * 60 * 1000))).toBe(true);
    expect(isXaiTokenExpired(tok(30 * 60 * 1000))).toBe(false);
    expect(isXaiTokenExpired(tok(-1000))).toBe(true);
  });
});

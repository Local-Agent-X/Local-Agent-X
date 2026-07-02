/**
 * Background auth-refresh must STOP retrying a permanently-dead credential.
 *
 * Regression (2026-07-02): a 12-day-expired legacy Anthropic refresh token made
 * the 2-minute timer POST a refresh every tick, each returning
 * `400 invalid_grant`, flooding server.log with an error line every 2 minutes
 * for hours — while the user was signed in fine via the Claude CLI creds. The
 * fix classifies unrecoverable OAuth errors and gives up on that exact token
 * until a fresh login (new refresh token) re-arms it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const loadAnthropicTokens = vi.fn();
const refreshAnthropicTokens = vi.fn();
vi.mock("./anthropic.js", () => ({ loadAnthropicTokens, refreshAnthropicTokens }));
vi.mock("./index.js", () => ({ loadTokens: vi.fn(() => null), refreshTokens: vi.fn() }));

const { tickAnthropic, isUnrecoverableRefreshError, _resetAbandonedRefreshTokens } =
  await import("./refresh.js");

const EXPIRED = { accessToken: "a", refreshToken: "dead-token", expiresAt: 1, method: "oauth" as const, provider: "anthropic" as const };

beforeEach(() => {
  vi.clearAllMocks();
  _resetAbandonedRefreshTokens();
});

describe("isUnrecoverableRefreshError", () => {
  it("flags OAuth 'credential is dead' codes", () => {
    for (const body of [
      "Anthropic token refresh failed (400): {\"error\": \"invalid_grant\"}",
      "refresh failed (401): {\"error\":\"invalid_client\"}",
      "refresh failed (400): {\"error\":\"unauthorized_client\"}",
    ]) expect(isUnrecoverableRefreshError(body)).toBe(true);
  });

  it("does NOT flag transient failures — those should keep retrying", () => {
    for (const body of [
      "Token refresh failed (503): upstream unavailable",
      "fetch failed: ECONNRESET",
      "The operation was aborted due to timeout",
      "Token refresh failed (429): rate limited",
    ]) expect(isUnrecoverableRefreshError(body)).toBe(false);
  });
});

describe("tickAnthropic give-up behavior", () => {
  it("stops retrying after an invalid_grant — second tick does not call refresh", async () => {
    loadAnthropicTokens.mockReturnValue(EXPIRED);
    refreshAnthropicTokens.mockRejectedValue(new Error('Anthropic token refresh failed (400): {"error": "invalid_grant"}'));

    await tickAnthropic();
    await tickAnthropic();
    await tickAnthropic();

    expect(refreshAnthropicTokens).toHaveBeenCalledTimes(1); // gave up after the first failure
  });

  it("keeps retrying a transient failure across ticks", async () => {
    loadAnthropicTokens.mockReturnValue(EXPIRED);
    refreshAnthropicTokens.mockRejectedValue(new Error("Token refresh failed (503): upstream unavailable"));

    await tickAnthropic();
    await tickAnthropic();

    expect(refreshAnthropicTokens).toHaveBeenCalledTimes(2); // still trying
  });

  it("re-arms when a fresh login supplies a new refresh token", async () => {
    loadAnthropicTokens.mockReturnValue(EXPIRED);
    refreshAnthropicTokens.mockRejectedValue(new Error('refresh failed (400): {"error":"invalid_grant"}'));
    await tickAnthropic(); // abandons "dead-token"

    // User re-logs-in: new file, new refresh token, still near expiry.
    loadAnthropicTokens.mockReturnValue({ ...EXPIRED, refreshToken: "fresh-token" });
    await tickAnthropic();

    expect(refreshAnthropicTokens).toHaveBeenCalledTimes(2); // tried again for the new token
  });
});

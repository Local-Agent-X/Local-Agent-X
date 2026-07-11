import { describe, it, expect } from "vitest";
import { isPlanFallbackWorthy } from "./stream.js";

describe("isPlanFallbackWorthy — when the direct-HTTP path should retry on the CLI", () => {
  it("retries on the exhausted extra-usage lane (the 'out of credits' 400)", () => {
    expect(isPlanFallbackWorthy("Anthropic 400: You're out of extra usage. Add more at claude.ai/settings/usage")).toBe(true);
  });
  it("retries on rate limits and overloaded", () => {
    expect(isPlanFallbackWorthy("Anthropic 429: rate limit exceeded")).toBe(true);
    expect(isPlanFallbackWorthy("Anthropic 529: overloaded")).toBe(true);
  });
  it("retries on auth/routing rejections the CLI can handle with its own creds", () => {
    expect(isPlanFallbackWorthy("Anthropic 401: token expired")).toBe(true);
    expect(isPlanFallbackWorthy("Anthropic 403: not allowed for this tier")).toBe(true);
  });
  it("does NOT retry a user abort (the CLI would just fail the same way)", () => {
    expect(isPlanFallbackWorthy("Anthropic request aborted before dispatch")).toBe(false);
  });
  it("does NOT retry a plain 400 malformed-request error", () => {
    expect(isPlanFallbackWorthy("Anthropic 400: messages: at least one message is required")).toBe(false);
  });
  it("is false for an empty/undefined error", () => {
    expect(isPlanFallbackWorthy(undefined)).toBe(false);
    expect(isPlanFallbackWorthy("")).toBe(false);
  });
});

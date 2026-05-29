import { describe, expect, it, beforeEach } from "vitest";

import {
  recentlyDone,
  markDone,
  fingerprintOf,
  describeAge,
  _clearIdempotencyStoreForTests,
} from "./idempotency.js";

describe("idempotency store", () => {
  beforeEach(() => _clearIdempotencyStoreForTests());

  it("returns null when nothing is recorded", () => {
    expect(recentlyDone("email_send", "fp1", 60_000)).toBeNull();
  });

  it("returns the prior result inside the window", () => {
    markDone("email_send", "fp1", "msg-id-42");
    const hit = recentlyDone("email_send", "fp1", 60_000);
    expect(hit?.result).toBe("msg-id-42");
    expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("isolates by tool name", () => {
    markDone("email_send", "fp1", "x");
    expect(recentlyDone("x_post", "fp1", 60_000)).toBeNull();
  });

  it("isolates by fingerprint", () => {
    markDone("email_send", "fp1", "x");
    expect(recentlyDone("email_send", "fp2", 60_000)).toBeNull();
  });

  it("respects the window — older than window returns null", () => {
    markDone("email_send", "fp1", "x");
    // 0ms window forces age > window for any entry
    expect(recentlyDone("email_send", "fp1", 0)).toBeNull();
  });
});

describe("fingerprintOf", () => {
  it("is stable for the same inputs", () => {
    expect(fingerprintOf("a", "b", "c")).toBe(fingerprintOf("a", "b", "c"));
  });

  it("trims whitespace per part", () => {
    expect(fingerprintOf(" a ", "b")).toBe(fingerprintOf("a", "b"));
  });

  it("treats missing parts as empty", () => {
    expect(fingerprintOf("a", "", "c")).not.toBe(fingerprintOf("a", "c"));
    // ^^ the empty middle part still occupies a slot, so the joined
    // representation differs from omitting it. Documents the behavior:
    // callers should pass placeholders consistently across calls.
  });
});

describe("describeAge", () => {
  it("formats ms windows", () => {
    expect(describeAge(500)).toBe("just now");
    expect(describeAge(30_000)).toBe("30s ago");
    expect(describeAge(5 * 60_000)).toBe("5 min ago");
    expect(describeAge(2 * 3_600_000)).toBe("2h ago");
  });
});

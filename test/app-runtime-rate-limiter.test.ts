import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../src/app-runtime/rate-limiter.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter", () => {
  it("allows up to maxPerWindow calls in the window", () => {
    const r = new RateLimiter(3, 1000);
    expect(r.check("k1")).toBe(true);
    expect(r.check("k1")).toBe(true);
    expect(r.check("k1")).toBe(true);
  });

  it("rejects calls beyond maxPerWindow within the window", () => {
    const r = new RateLimiter(3, 1000);
    r.check("k1");
    r.check("k1");
    r.check("k1");
    expect(r.check("k1")).toBe(false);
  });

  it("resets the bucket after the window elapses", () => {
    const r = new RateLimiter(2, 1000);
    expect(r.check("k1")).toBe(true);
    expect(r.check("k1")).toBe(true);
    expect(r.check("k1")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(r.check("k1")).toBe(true);
  });

  it("buckets per key — k1 hitting limit does not affect k2", () => {
    const r = new RateLimiter(2, 1000);
    r.check("k1");
    r.check("k1");
    expect(r.check("k1")).toBe(false);
    expect(r.check("k2")).toBe(true);
    expect(r.check("k2")).toBe(true);
  });

  it("reset(key) clears the bucket for that key", () => {
    const r = new RateLimiter(2, 1000);
    r.check("k1");
    r.check("k1");
    expect(r.check("k1")).toBe(false);
    r.reset("k1");
    expect(r.check("k1")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  classify,
  isRetryable,
  isRetryableTool,
  backoffMs,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_COOLDOWN_MS,
} from "../src/resilience-policy.js";

describe("classify", () => {
  it("flags rate limits", () => {
    expect(classify(new Error("Rate limit exceeded"))).toBe("rateLimit");
    expect(classify("HTTP 429 Too Many Requests")).toBe("rateLimit");
    expect(classify(new Error("insufficient_quota: please upgrade"))).toBe("rateLimit");
    expect(classify({ status: 429 })).toBe("rateLimit");
  });

  it("flags auth", () => {
    expect(classify("401 Unauthorized")).toBe("auth");
    expect(classify(new Error("Invalid API key provided"))).toBe("auth");
    expect(classify(new Error("token expired"))).toBe("auth");
    expect(classify({ status: 403 })).toBe("auth");
  });

  it("flags content filters", () => {
    expect(classify(new Error("Response blocked by content_filter"))).toBe("contentFilter");
    expect(classify("triggered content moderation")).toBe("contentFilter");
    expect(classify(new Error("safety filter activated"))).toBe("contentFilter");
  });

  it("flags timeouts", () => {
    expect(classify(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("timeout");
    expect(classify("The operation was aborted due to timeout")).toBe("timeout");
    expect(classify({ status: 504 })).toBe("timeout");
  });

  it("flags network errors", () => {
    expect(classify(new Error("read ECONNRESET"))).toBe("network");
    expect(classify("socket hang up")).toBe("network");
    expect(classify(new Error("fetch failed"))).toBe("network");
  });

  it("flags overload / 5xx", () => {
    expect(classify("503 Service Unavailable")).toBe("overload");
    expect(classify(new Error("Anthropic API overloaded, please try again"))).toBe("overload");
    expect(classify("502 Bad Gateway")).toBe("overload");
    expect(classify({ status: 500 })).toBe("overload");
  });

  it("returns unknown for caller-fault / unrecognized errors", () => {
    expect(classify(new Error("400 Bad Request: missing field"))).toBe("unknown");
    expect(classify("")).toBe("unknown");
    expect(classify(null)).toBe("unknown");
    expect(classify(undefined)).toBe("unknown");
    expect(classify(new Error("nonsense"))).toBe("unknown");
  });
});

describe("isRetryableTool", () => {
  it("allows network-ish tools", () => {
    expect(isRetryableTool("http_request")).toBe(true);
    expect(isRetryableTool("web_fetch")).toBe(true);
    expect(isRetryableTool("browser")).toBe(true);
  });

  it("blocks mutating / unknown tools", () => {
    expect(isRetryableTool("bash")).toBe(false);
    expect(isRetryableTool("write")).toBe(false);
    expect(isRetryableTool("edit")).toBe(false);
    expect(isRetryableTool("agent_spawn")).toBe(false);
    expect(isRetryableTool("read")).toBe(false);
  });
});

describe("isRetryable", () => {
  it("retries transient categories", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryable(new Error("rate limit"))).toBe(true);
    expect(isRetryable(new Error("503 overloaded"))).toBe(true);
    expect(isRetryable(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("does not retry caller-fault categories", () => {
    expect(isRetryable(new Error("401 Unauthorized"))).toBe(false);
    expect(isRetryable(new Error("blocked by content_filter"))).toBe(false);
    expect(isRetryable(new Error("400 Bad Request"))).toBe(false);
  });

  it("gates on tool eligibility when toolName is supplied", () => {
    const transient = new Error("ECONNRESET");
    expect(isRetryable(transient, { toolName: "web_fetch" })).toBe(true);
    expect(isRetryable(transient, { toolName: "bash" })).toBe(false);
  });

  it("preserves the live transient set run-sandboxed relied on", () => {
    for (const msg of ["timeout", "timed out", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "rate limit", "429", "503", "504", "network"]) {
      expect(isRetryable(new Error(msg), { toolName: "web_fetch" })).toBe(true);
    }
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays within the cap", () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(1000);
    expect(backoffMs(1)).toBeLessThanOrEqual(8_000);
    expect(backoffMs(10)).toBeLessThanOrEqual(8_000);
  });

  it("gives rate-limit / overload a higher ceiling", () => {
    expect(backoffMs(10, "rateLimit")).toBeGreaterThan(8_000);
    expect(backoffMs(10, "overload")).toBeLessThanOrEqual(16_000);
  });
});

describe("circuit thresholds", () => {
  it("exposes the breaker defaults", () => {
    expect(CIRCUIT_FAILURE_THRESHOLD).toBe(4);
    expect(CIRCUIT_COOLDOWN_MS).toBe(30_000);
  });
});

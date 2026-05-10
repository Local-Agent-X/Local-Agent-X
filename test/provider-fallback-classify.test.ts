import { describe, it, expect } from "vitest";
import { classifyProviderError } from "../src/provider-fallback.js";

describe("classifyProviderError — rate-limit", () => {
  it("flags 'rate limit'", () => {
    expect(classifyProviderError(new Error("Rate limit exceeded"))).toBe("rate-limit");
  });

  it("flags HTTP 429", () => {
    expect(classifyProviderError("HTTP 429 Too Many Requests")).toBe("rate-limit");
  });

  it("flags 'insufficient_quota'", () => {
    expect(classifyProviderError(new Error("insufficient_quota: please upgrade"))).toBe("rate-limit");
  });
});

describe("classifyProviderError — auth", () => {
  it("flags 401 unauthorized", () => {
    expect(classifyProviderError("401 Unauthorized")).toBe("auth");
  });

  it("flags invalid api key", () => {
    expect(classifyProviderError(new Error("Invalid API key provided"))).toBe("auth");
  });

  it("flags expired token", () => {
    expect(classifyProviderError(new Error("token expired"))).toBe("auth");
  });
});

describe("classifyProviderError — overload", () => {
  it("flags 503 service unavailable", () => {
    expect(classifyProviderError("503 Service Unavailable")).toBe("overload");
  });

  it("flags 'overloaded'", () => {
    expect(classifyProviderError(new Error("Anthropic API overloaded, please try again"))).toBe("overload");
  });

  it("flags 502 bad gateway", () => {
    expect(classifyProviderError("502 Bad Gateway")).toBe("overload");
  });
});

describe("classifyProviderError — network", () => {
  it("flags ETIMEDOUT", () => {
    expect(classifyProviderError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("network");
  });

  it("flags ECONNRESET", () => {
    expect(classifyProviderError(new Error("read ECONNRESET"))).toBe("network");
  });

  it("flags 'socket hang up'", () => {
    expect(classifyProviderError("socket hang up")).toBe("network");
  });
});

describe("classifyProviderError — content-filter", () => {
  it("flags 'content_filter'", () => {
    expect(classifyProviderError(new Error("Response blocked by content_filter"))).toBe("content-filter");
  });

  it("flags 'content moderation'", () => {
    expect(classifyProviderError("triggered content moderation")).toBe("content-filter");
  });

  it("flags 'safety filter'", () => {
    expect(classifyProviderError(new Error("safety filter activated"))).toBe("content-filter");
  });
});

describe("classifyProviderError — non-transient", () => {
  it("returns null for a 400 bad request shape (caller's fault)", () => {
    expect(classifyProviderError(new Error("400 Bad Request: missing field"))).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(classifyProviderError("")).toBeNull();
    expect(classifyProviderError(null)).toBeNull();
    expect(classifyProviderError(undefined)).toBeNull();
  });

  it("returns null for arbitrary unrecognized error text", () => {
    expect(classifyProviderError(new Error("Tool 'foo' not found"))).toBeNull();
  });
});

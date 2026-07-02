// Regression for PR-2: the connect timeout must NOT abort the response body.
// AbortSignal.timeout() kept counting after headers and truncated long LLM
// streams. connectTimeout() bounds only the connect phase and is cleared once
// headers arrive.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectTimeout } from "./connect-timeout.js";

describe("connectTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts if headers never arrive within the window", () => {
    const ct = connectTimeout(1000, undefined, "Test");
    expect(ct.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(ct.signal.aborted).toBe(true);
    expect(ct.timedOut()).toBe(true);
  });

  it("does NOT abort the body once cleared — even long past the window (the fix)", () => {
    const ct = connectTimeout(1000, undefined, "Test");
    ct.clear(); // headers arrived
    vi.advanceTimersByTime(60_000); // a 60s generation
    expect(ct.signal.aborted).toBe(false);
    expect(ct.timedOut()).toBe(false);
  });

  it("stays abortable by the external signal after clear (barge-in / op-cancel)", () => {
    const external = new AbortController();
    const ct = connectTimeout(1000, external.signal, "Test");
    ct.clear();
    expect(ct.signal.aborted).toBe(false);
    external.abort();
    expect(ct.signal.aborted).toBe(true);
    // It was the caller's cancel, not the timer — a retry loop must treat this
    // as terminal, not as a retryable timeout.
    expect(ct.timedOut()).toBe(false);
  });

  it("reports timedOut=false when the external signal wins the race", () => {
    const external = new AbortController();
    const ct = connectTimeout(1000, external.signal, "Test");
    external.abort();
    expect(ct.signal.aborted).toBe(true);
    expect(ct.timedOut()).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { readIdleTimeoutMs } from "./idle-watchdog.js";

const KEY = "LAX_CANONICAL_IDLE_TIMEOUT_MS";

describe("readIdleTimeoutMs", () => {
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("returns the 600s default when unset", () => {
    delete process.env[KEY];
    expect(readIdleTimeoutMs()).toBe(600000);
  });

  it("honors a valid positive override", () => {
    process.env[KEY] = "120000";
    expect(readIdleTimeoutMs()).toBe(120000);
  });

  it("falls back to the default on a malformed (NaN) override instead of returning NaN", () => {
    // Pre-fix: bare parseInt("abc",10) => NaN, setTimeout(cb, NaN) fires
    // immediately and the re-arm guard is always false => every turn aborts
    // as 'stalled' in ms.
    process.env[KEY] = "abc";
    const v = readIdleTimeoutMs();
    expect(Number.isNaN(v)).toBe(false);
    expect(v).toBe(600000);
  });

  it("falls back to the default on a non-positive override", () => {
    process.env[KEY] = "0";
    expect(readIdleTimeoutMs()).toBe(600000);
    process.env[KEY] = "-5";
    expect(readIdleTimeoutMs()).toBe(600000);
  });
});

/**
 * schedule-nl tests — the deterministic guardrails around the LLM translator.
 *
 * The model call itself is non-deterministic and falls back to null without a
 * provider, so these lock in the two things that make it SAFE to trust for a
 * scheduling primitive: the short-circuit (valid input never reaches the model)
 * and graceful failure (vague/empty/no-provider never throws).
 */

import { describe, it, expect } from "vitest";
import { isParseableSchedule, parseScheduleNL } from "./schedule-nl.js";

describe("isParseableSchedule", () => {
  it("accepts intervals and 5-field cron expressions", () => {
    expect(isParseableSchedule("5m")).toBe(true);
    expect(isParseableSchedule("2h")).toBe(true);
    expect(isParseableSchedule("0 9 * * *")).toBe(true);
    expect(isParseableSchedule("0 9 * * 1-5")).toBe(true);
    expect(isParseableSchedule("* * * * *")).toBe(true);
  });
  it("rejects natural language and malformed expressions", () => {
    expect(isParseableSchedule("every weekday at 9am")).toBe(false);
    expect(isParseableSchedule("daily 9am")).toBe(false);
    expect(isParseableSchedule("* * * *")).toBe(false); // only 4 fields
    expect(isParseableSchedule("")).toBe(false);
  });
});

describe("parseScheduleNL", () => {
  it("short-circuits an already-valid schedule with no model call", async () => {
    // Returns synchronously-valid input verbatim — provable offline (no provider
    // configured in the test env), so reaching the model would yield null.
    await expect(parseScheduleNL("0 9 * * 1-5")).resolves.toEqual({
      schedule: "0 9 * * 1-5",
      description: "0 9 * * 1-5",
    });
    await expect(parseScheduleNL("15m")).resolves.toEqual({ schedule: "15m", description: "15m" });
  });

  it("returns null (never throws) for empty/blank input", async () => {
    await expect(parseScheduleNL("")).resolves.toBeNull();
    await expect(parseScheduleNL("   ")).resolves.toBeNull();
  });

  it("falls back to null gracefully when no provider can translate NL", async () => {
    // No provider in the unit env → classifyJson yields null. The function must
    // surface that as a clean null, not an exception.
    await expect(parseScheduleNL("every other tuesday at 3pm")).resolves.toBeNull();
  });
});

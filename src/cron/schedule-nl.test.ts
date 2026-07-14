/**
 * schedule-nl tests — the deterministic guardrails around the LLM translator.
 *
 * The model call itself is non-deterministic and falls back to null without a
 * provider, so these lock in the two things that make it SAFE to trust for a
 * scheduling primitive: the short-circuit (valid input never reaches the model)
 * and graceful failure (vague/empty/no-provider never throws).
 */

import { describe, it, expect, vi } from "vitest";
import { isParseableSchedule, parseScheduleNL } from "./schedule-nl.js";

type Llm = (systemPrompt: string, userPrompt: string) => Promise<string | null>;

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
    // No provider in the unit env → the classifier yields null. The function
    // must surface that as a clean null, not an exception.
    await expect(parseScheduleNL("every other tuesday at 3pm")).resolves.toBeNull();
  });
});

describe("parseScheduleNL — schema-validated model path (injected _llm)", () => {
  it("accepts a valid reply and normalizes it", async () => {
    const llm = vi.fn<Llm>(async () =>
      `{"schedule":" 0 9 * * 1-5 ","description":"  Every weekday at 9:00 AM  "}`);
    await expect(parseScheduleNL("every weekday at 9am", { _llm: llm })).resolves.toEqual({
      schedule: "0 9 * * 1-5",
      description: "Every weekday at 9:00 AM",
    });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("rejects an LLM 'valid JSON' whose schedule the real cron parser can't run — retry, then null", async () => {
    // THE deterministic re-validation gate: syntactically fine JSON carrying a
    // hallucinated schedule must fail the schema, get one self-correction
    // retry, and surface as null — never a garbage schedule.
    const llm = vi.fn<Llm>(async () => `{"schedule":"every day at nine","description":"Daily 9am"}`);
    await expect(parseScheduleNL("daily at nine somehow", { _llm: llm })).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][1]).toContain("Your previous reply was invalid:");
  });

  it("self-corrects on retry: bad cron first, valid schedule second", async () => {
    const llm = vi.fn<Llm>()
      .mockResolvedValueOnce(`{"schedule":"0 9 * *","description":"broken 4-field"}`)
      .mockResolvedValueOnce(`{"schedule":"0 9 * * *","description":"Every day at 9:00 AM"}`);
    await expect(parseScheduleNL("daily 9am", { _llm: llm })).resolves.toEqual({
      schedule: "0 9 * * *",
      description: "Every day at 9:00 AM",
    });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("the vague-phrase empty schedule fails the gate → null", async () => {
    const llm = vi.fn<Llm>(async () => `{"schedule":"","description":"too vague"}`);
    await expect(parseScheduleNL("sometimes, when it rains", { _llm: llm })).resolves.toBeNull();
  });

  it("non-JSON garbage → null (deterministic fallback contract unchanged)", async () => {
    const llm = vi.fn<Llm>(async () => "I would suggest a cron of 0 9 * * *.");
    await expect(parseScheduleNL("every weekday at 9am", { _llm: llm })).resolves.toBeNull();
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it("missing/non-string description defaults to the schedule itself", async () => {
    const llm = vi.fn<Llm>(async () => `{"schedule":"15m"}`);
    // "every quarter hour" isn't parseable as-is, so it reaches the model.
    await expect(parseScheduleNL("every quarter hour", { _llm: llm })).resolves.toEqual({
      schedule: "15m",
      description: "15m",
    });
  });
});

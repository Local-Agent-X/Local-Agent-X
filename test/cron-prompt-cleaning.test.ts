import { describe, it, expect } from "vitest";
import { stripCronPreamble, stripSaveInstructions } from "../src/server/background-jobs/prompt-cleaning.js";

// Regression for the mangled "Save date].md" tail (June 2026): the save path
// carried a bracketed placeholder with a space ("[today's date]"), and the old
// \S+ matchers severed it mid-token, leaving an orphaned verb + fragment that
// made the agent think the task was truncated and refuse.
describe("stripSaveInstructions", () => {
  it("strips a trailing save directive whose path has a spaced [placeholder]", () => {
    const input =
      "Cover trending ingredients and a what-to-stock summary. Focus on practical " +
      "retail relevance. Save output to workspace/reports/supplements-[today's date].md";
    const out = stripSaveInstructions(input);
    expect(out).toBe(
      "Cover trending ingredients and a what-to-stock summary. Focus on practical retail relevance",
    );
    expect(out).not.toMatch(/save/i);
    expect(out).not.toContain("].md");
  });

  it("strips an extensionless trailing workspace path", () => {
    const out = stripSaveInstructions("Do the research thoroughly, save it to workspace/research/daily");
    expect(out).toBe("Do the research thoroughly");
    expect(out).not.toContain("workspace/");
  });

  it("strips a 'write ... to <path>.md' variant mid-conjunction", () => {
    expect(
      stripSaveInstructions("Summarize the findings and write the report to research/out.md"),
    ).toBe("Summarize the findings");
  });

  it("leaves a prompt with no save directive untouched", () => {
    const input =
      "Research the most viral AI topics on X today. Summarize what is trending, " +
      "why it is spreading, and who is driving it. Do NOT call mission_schedule_create.";
    expect(stripSaveInstructions(input)).toBe(input);
  });

  it("does not eat a mid-prompt mention that isn't a trailing directive", () => {
    const input = "Note that creatine.md is a filename users search for. Report on demand shifts.";
    expect(stripSaveInstructions(input)).toBe(input);
  });

  it("does not treat the noun 'store' as a save verb (real over-strip bug)", () => {
    const input =
      "Cover: 4) anything relevant to a physical supplement retail store, 5) a what-to-stock " +
      "summary. Focus on practical retail relevance. Save output to workspace/reports/x-[today's date].md";
    const out = stripSaveInstructions(input);
    expect(out).toBe(
      "Cover: 4) anything relevant to a physical supplement retail store, 5) a what-to-stock " +
        "summary. Focus on practical retail relevance",
    );
  });
});

describe("stripCronPreamble", () => {
  it("strips a leading 'every day at' schedule preamble", () => {
    expect(stripCronPreamble("Every day at 8am, research supplement trends.")).toBe(
      "research supplement trends.",
    );
  });

  it("leaves a prompt with no preamble untouched", () => {
    expect(stripCronPreamble("Research supplement trends.")).toBe("Research supplement trends.");
  });
});

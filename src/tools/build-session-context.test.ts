import { describe, it, expect } from "vitest";
import { extractBuildBrief, renderPriorBuildBlock, type PriorBuildEntry } from "./build-session-context.js";

describe("extractBuildBrief", () => {
  it("pulls the Instructions line out of a seeded per-build context", () => {
    const seeded =
      "You are building a web app in the directory: /x\n" +
      "App name: maze\n\nEnvironment:\n- stuff\n\n" +
      "Instructions: a 3D maze escape game with WASD movement\n\nRULES:\n- Write ALL files";
    expect(extractBuildBrief(seeded)).toBe("a 3D maze escape game with WASD movement");
  });

  it("falls back to the raw text when the shape is unfamiliar", () => {
    expect(extractBuildBrief("just fix the timer")).toBe("just fix the timer");
  });
});

describe("renderPriorBuildBlock", () => {
  const entry = (over: Partial<PriorBuildEntry>): PriorBuildEntry => ({
    createdAt: "2026-07-06T23:31:00.000Z",
    status: "completed",
    brief: "a 3D maze escape game",
    finalReport: "APP_READY — maze built with canvas renderer",
    ...over,
  });

  it("returns null with no history — an update on a pre-feature app runs unchanged", () => {
    expect(renderPriorBuildBlock([])).toBeNull();
  });

  it("renders brief + final report and frames the build as a continuation", () => {
    const block = renderPriorBuildBlock([entry({})])!;
    expect(block).toContain("PRIOR BUILD SESSIONS");
    expect(block).toContain("CONTINUING this app");
    expect(block).toContain("[2026-07-06] brief: a 3D maze escape game");
    expect(block).toContain("builder's final report: APP_READY — maze built with canvas renderer");
    expect(block).toContain("UNVERIFIED");
  });

  it("tags a failed attempt so the fixer doesn't repeat the approach", () => {
    const block = renderPriorBuildBlock([entry({ status: "failed", finalReport: "smoke gate: page renders NOTHING" })])!;
    expect(block).toContain("BUILD FAILED — do not repeat this approach");
  });
});

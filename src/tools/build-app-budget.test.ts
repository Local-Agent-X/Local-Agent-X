import { describe, expect, it } from "vitest";
import { BUILD_APP_BUDGET } from "./build-app.js";

describe("Build App execution budget", () => {
  it("uses iteration checkpoints without a wall-clock termination", () => {
    expect(BUILD_APP_BUDGET.maxIterations).toBeGreaterThan(0);
    expect(BUILD_APP_BUDGET.maxWallTimeMs).toBe(0);
  });
});

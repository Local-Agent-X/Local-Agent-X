import { describe, it, expect } from "vitest";
import { checkVerdict } from "./check-verdict.js";

describe("checkVerdict", () => {
  it("only a clean run passes and only a run that reported a problem fails", () => {
    expect(checkVerdict("ok")).toBe("passed");
    expect(checkVerdict("error")).toBe("failed");
  });
  it("a check that never ran or never answered has no verdict", () => {
    for (const s of ["blocked", "declined", "timeout", "running", "cancelled", undefined] as const) {
      expect(checkVerdict(s), String(s)).toBe("none");
    }
  });
});

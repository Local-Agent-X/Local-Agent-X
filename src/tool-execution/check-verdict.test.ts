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
  it("the command's own exit code decides a run that happened; it never makes one that did not", () => {
    expect(checkVerdict("ok", 0)).toBe("passed");
    expect(checkVerdict("error", 2)).toBe("failed");
    expect(checkVerdict("ok", 2)).toBe("failed");
    expect(checkVerdict("error", 0)).toBe("passed");
    for (const s of ["blocked", "timeout", "declined", "cancelled", undefined] as const) {
      expect(checkVerdict(s, 0), String(s)).toBe("none");
    }
  });
});

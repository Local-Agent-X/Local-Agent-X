import { describe, it, expect } from "vitest";
import { declined, blocked, statusOf, parseStatusHeader, renderToolResultForModel } from "./result-helpers.js";
import { USER_HINTS } from "../types.js";

// Regression for the "declined" status (user said no to THIS call, distinct
// from a policy "blocked"). parseStatusHeader enumerates statuses explicitly,
// so a missing entry silently misreads every declined result as "ok"
// downstream — these tests pin the round-trip.
describe("declined tool-result status", () => {
  it("declined() builds an isError envelope with status 'declined'", () => {
    const r = declined("DECLINED by user: bash", { layer: "approval" });
    expect(r.status).toBe("declined");
    expect(r.isError).toBe(true);
    expect(statusOf(r)).toBe("declined");
  });

  it("parseStatusHeader round-trips a rendered declined result", () => {
    const r = declined("DECLINED by user: bash. Do not retry the same call.", {
      layer: "approval",
      userHint: USER_HINTS.declined,
    });
    const rendered = renderToolResultForModel(r);
    expect(rendered.startsWith("[declined")).toBe(true);
    expect(rendered).toContain(`User hint: ${USER_HINTS.declined}`);
    expect(parseStatusHeader(rendered)).toBe("declined");
  });

  it("declined stays distinct from blocked through render + parse", () => {
    const b = renderToolResultForModel(blocked("BLOCKED by profile: bash"));
    const d = renderToolResultForModel(declined("DECLINED by user: bash"));
    expect(parseStatusHeader(b)).toBe("blocked");
    expect(parseStatusHeader(d)).toBe("declined");
  });
});

import { describe, it, expect } from "vitest";
import { declined, blocked, err, ok, statusOf, parseStatusHeader, renderToolResultForModel } from "./result-helpers.js";
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
    const b = renderToolResultForModel(blocked("BLOCKED by profile: bash", { layer: "approval", recovery: "Ask the user." }));
    const d = renderToolResultForModel(declined("DECLINED by user: bash"));
    expect(parseStatusHeader(b)).toBe("blocked");
    expect(parseStatusHeader(d)).toBe("declined");
  });
});

// Two success renderings, each load-bearing: a bare ok() renders verbatim
// (grep's "No matches found." and the replayed tool message are matched from
// position 0), and the app tools' ok() carries an [ok] header (without it Grok
// re-verified finished work in a loop, 69cdccba3). One ok() for both breaks one.
describe("ok() success rendering", () => {
  it("renders a bare ok() verbatim and an err() with its header", () => {
    expect(renderToolResultForModel(ok("No matches found."))).toBe("No matches found.");
    expect(renderToolResultForModel(err("boom"))).toBe("[error]\nboom");
  });

  it("gives an app tool's success an [ok] header", async () => {
    const { ok: appOk } = await import("./app-tools/shared.js");
    expect(renderToolResultForModel(appOk("Pinned."))).toBe("[ok]\nPinned.");
  });
});

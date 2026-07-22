/**
 * handleObserve — the role-grouped observe view must degrade honestly when
 * element extraction failed: before this change it rendered "0 elements" with
 * empty buckets, indistinguishable from a genuinely empty page.
 */
import { describe, expect, it } from "vitest";
import type { BrowserBackend } from "../../browser/index.js";
import type { BrowserObservation, DurableRef } from "../../browser/observation.js";
import { handleObserve } from "./observe.js";

const SUBMIT: DurableRef = {
  id: 1, signature: "button|Submit|BUTTON|form", role: "button", name: "Submit",
  tag: "BUTTON", type: "", xpath: "/button[1]", inViewport: true, lastSeen: 1,
  rect: { x: 10, y: 10, width: 80, height: 20 },
};

function makeObs(overrides: Partial<BrowserObservation>): BrowserObservation {
  return {
    url: "https://example.com/a",
    title: "Example",
    isInitial: true,
    full: [],
    added: [],
    removed: [],
    changed: [],
    offscreenCount: 0,
    totalCount: 0,
    currentRefs: [],
    obstructions: [],
    dialogs: [],
    crossOriginIframes: [],
    ...overrides,
  };
}

function fakeManager(obs: BrowserObservation): BrowserBackend {
  return {
    getCurrentUrl: () => obs.url,
    observe: async () => obs,
  } as unknown as BrowserBackend;
}

describe("handleObserve — degraded element extraction", () => {
  it("reports the failure + screenshot steer instead of misleading zero counts", async () => {
    const obs = makeObs({ degraded: [{ op: "elements", reason: "Execution context\nwas destroyed" }] });
    const res = await handleObserve(fakeManager(obs));

    expect(res.content).toContain("OBSERVATION DEGRADED: element extraction FAILED");
    expect(res.content).toContain("Execution context was destroyed");
    expect(res.content).toContain('browser({action:"screenshot"})');
    // The old output — empty role buckets read as a clean empty page.
    expect(res.content).not.toContain("Buttons (0):");
    expect(res.content).not.toContain("0 elements");
  });

  it("healthy page: grouped output unchanged, no degraded notice", async () => {
    const obs = makeObs({ full: [SUBMIT], currentRefs: [SUBMIT], totalCount: 1 });
    const res = await handleObserve(fakeManager(obs));

    expect(res.content).not.toContain("OBSERVATION DEGRADED");
    expect(res.content).toContain("1 elements (1 in viewport, 0 below fold)");
    expect(res.content).toContain('Buttons (1):');
    expect(res.content).toContain('[1] button "Submit"');
  });

  it("a non-element degradation (obstruction detector) does not suppress the element view", async () => {
    const obs = makeObs({
      full: [SUBMIT], currentRefs: [SUBMIT], totalCount: 1,
      degraded: [{ op: "obstructions", reason: "detector crashed" }],
    });
    const res = await handleObserve(fakeManager(obs));

    expect(res.content).not.toContain("OBSERVATION DEGRADED");
    expect(res.content).toContain('[1] button "Submit"');
  });
});

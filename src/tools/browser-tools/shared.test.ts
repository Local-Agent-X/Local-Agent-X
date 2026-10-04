/**
 * appendPostActionSnapshot — what a fill/select result shows of the page.
 *
 * The login-wall banner it used to prefix was removed (2026-10-03): it
 * guessed from page text and fired on logged-in pages. Password fields are
 * now a hard rule at every fill path (browser/password-field-rule.ts).
 */
import { describe, it, expect } from "vitest";
import { appendPostActionSnapshot } from "./shared.js";
import { ObservationRegistry, type BrowserObservation } from "../../browser/observation.js";

describe("appendPostActionSnapshot — a degraded observation stays loud in the tool result", () => {
  it("the extraction-failure notice and screenshot steer survive the external-content wrap", async () => {
    const obs: BrowserObservation = {
      url: "https://example.com/a",
      title: "Example",
      isInitial: false,
      added: [], removed: [], changed: [],
      offscreenCount: 0, totalCount: 0, currentRefs: [],
      obstructions: [], dialogs: [], crossOriginIframes: [],
      degraded: [{ op: "elements", reason: "Execution context was destroyed" }],
    };
    const manager = {
      snapshot: async () => ObservationRegistry.format(obs),
      getCurrentUrl: () => "https://example.com/a",
    };
    const out = await appendPostActionSnapshot(manager, "Filled [3]");

    expect(out).toContain("Filled [3]");
    expect(out).toContain("== OBSERVATION DEGRADED");
    expect(out).toContain("Element extraction FAILED: Execution context was destroyed");
    expect(out).toContain('browser({action:"screenshot"})');
    // Never the silent shape the bug produced: an unexplained clean page.
    expect(out).not.toContain("Page unchanged since last observation");
    expect(out).not.toContain("interactive elements:");
  });
});

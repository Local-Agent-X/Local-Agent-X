import { describe, it, expect, beforeEach } from "vitest";
import { recordProgress, resetProgress, NO_PROGRESS_LIMIT } from "../src/browser/progress-tracker.js";

describe("browser no-progress tracker", () => {
  const sid = "s1";
  beforeEach(() => resetProgress(sid));

  it("never stalls while the fingerprint keeps changing", () => {
    for (let i = 0; i < NO_PROGRESS_LIMIT * 3; i++) {
      expect(recordProgress(sid, `fp-${i}`).stalled).toBe(false);
    }
  });

  it("stalls after NO_PROGRESS_LIMIT identical fingerprints", () => {
    expect(recordProgress(sid, "same").stalled).toBe(false); // first sighting
    for (let i = 1; i < NO_PROGRESS_LIMIT; i++) {
      expect(recordProgress(sid, "same").stalled).toBe(false);
    }
    expect(recordProgress(sid, "same").stalled).toBe(true);
  });

  it("keeps reporting stalled until the page changes", () => {
    for (let i = 0; i <= NO_PROGRESS_LIMIT; i++) recordProgress(sid, "same");
    expect(recordProgress(sid, "same").stalled).toBe(true);
    expect(recordProgress(sid, "moved").stalled).toBe(false); // change resets
    expect(recordProgress(sid, "moved").stalled).toBe(false);
  });

  it("treats an empty fingerprint as unknown, not progress or stall", () => {
    for (let i = 0; i < NO_PROGRESS_LIMIT; i++) recordProgress(sid, "same"); // unchanged = LIMIT-1
    expect(recordProgress(sid, "").stalled).toBe(false); // skipped, counter held
    expect(recordProgress(sid, "same").stalled).toBe(true); // one more change-free action trips it
  });

  it("isolates sessions", () => {
    for (let i = 0; i <= NO_PROGRESS_LIMIT; i++) recordProgress("a", "x");
    expect(recordProgress("b", "x").stalled).toBe(false);
    resetProgress("a");
    resetProgress("b");
  });
});

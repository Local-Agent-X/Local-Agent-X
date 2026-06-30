import { describe, it, expect } from "vitest";
import {
  looksLikeCleanupSweep,
  isEmptyGrepResult,
  noteCleanupEvidence,
  checkCleanupVerify,
  createCleanupVerifyState,
} from "./cleanup-verify.js";

// The first is the exact scenario the three models ran in the live comparison —
// a project-wide removal reported done off poisoned memory without a re-search.
const CLEANUPS = [
  "We switched this app off Tailscale. There are still out-of-date tailnet references left over in the code — go through the project and finish cleaning them up.",
  "Remove every reference to the deprecated flag throughout the project.",
  "Delete all usages of the old logger across the codebase.",
  "Migrate the whole codebase off moment.js and remove it from this project.",
  "Get rid of all the dead feature-flag mentions in the repo.",
  "Strip out the legacy auth code everywhere.",
];

const NOT_CLEANUPS = [
  "Add a logout button to the settings page.",
  "Rename getUser to fetchUser everywhere.", // rename: a clean grep doesn't prove it
  "Remove the unused import in bar.ts.",      // single named spot, no breadth
  "Clean up this function.",                  // no breadth cue
  "What's the capital of France?",
  "Summarize all the key points in this document.",
];

describe("looksLikeCleanupSweep", () => {
  it("fires on project-wide removal/cleanup tasks", () => {
    for (const t of CLEANUPS) expect(looksLikeCleanupSweep(t), t).toBe(true);
  });
  it("does NOT fire on non-removal / single-spot / read-only tasks", () => {
    for (const t of NOT_CLEANUPS) expect(looksLikeCleanupSweep(t), t).toBe(false);
  });
  it("ignores trivially short input", () => {
    expect(looksLikeCleanupSweep("remove all")).toBe(false);
    expect(looksLikeCleanupSweep("")).toBe(false);
  });
});

describe("isEmptyGrepResult", () => {
  it("recognizes grep's zero-match sentinel", () => {
    expect(isEmptyGrepResult("No matches found.")).toBe(true);
    expect(isEmptyGrepResult("  No matches found.\n")).toBe(true);
    expect(isEmptyGrepResult("No matches found")).toBe(true);
  });
  it("does NOT treat a content-mode line that mentions the phrase as empty", () => {
    expect(isEmptyGrepResult('src/x.ts:12:// log("No matches found.")')).toBe(false);
    expect(isEmptyGrepResult("src/a.ts\nsrc/b.ts")).toBe(false);
  });
});

describe("checkCleanupVerify + noteCleanupEvidence", () => {
  it("nudges once when a cleanup wraps up with no clean search in evidence", () => {
    const s = createCleanupVerifyState();
    const r = checkCleanupVerify(s);
    expect(r.nudge).toBeTruthy();
    expect(s.unverified).toBe(true);
    // fire-once
    expect(checkCleanupVerify(s).nudge).toBeNull();
    expect(s.unverified).toBe(true);
  });

  it("stays quiet and clears the verdict once a grep came back empty", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([{ toolName: "grep", content: "No matches found.", status: "ok" }], s);
    expect(s.confirmedClean).toBe(true);
    const r = checkCleanupVerify(s);
    expect(r.nudge).toBeNull();
    expect(s.unverified).toBe(false);
  });

  it("a grep that still returns matches is NOT proof — verdict stays unverified", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([{ toolName: "grep", content: "src/a.ts\nsrc/b.ts", status: "ok" }], s);
    expect(s.confirmedClean).toBe(false);
    expect(checkCleanupVerify(s).nudge).toBeTruthy();
    expect(s.unverified).toBe(true);
  });

  it("ignores an errored grep and a non-grep empty-looking result", () => {
    const s = createCleanupVerifyState();
    noteCleanupEvidence([
      { toolName: "grep", content: "No matches found.", status: "error" },
      { toolName: "bash", content: "No matches found.", status: "ok" },
    ], s);
    expect(s.confirmedClean).toBe(false);
  });

  it("recovery: a clean grep after the nudge clears the verdict", () => {
    const s = createCleanupVerifyState();
    expect(checkCleanupVerify(s).nudge).toBeTruthy(); // nudged, unverified
    noteCleanupEvidence([{ toolName: "grep", content: "No matches found.", status: "ok" }], s);
    checkCleanupVerify(s); // re-evaluate at the next wrap-up
    expect(s.unverified).toBe(false);
  });
});

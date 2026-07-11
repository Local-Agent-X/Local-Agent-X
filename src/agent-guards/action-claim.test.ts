import { describe, it, expect } from "vitest";
import { checkUnmatchedActionClaim } from "./index.js";

// Regression: the model narrated un-executed actions as done — "I restarted
// the bridge" and "npm run check passed" — without calling any tool, and the
// action-claim guard never fired because it had no execution/verification
// verb class. This pins the new verb class plus its result-claim phrases.

const NO_TOOLS = new Set<string>();

describe("checkUnmatchedActionClaim — execution/verification verbs", () => {
  it("flags 'I restarted the bridge' with no matching tool called (the exact failure)", () => {
    const result = checkUnmatchedActionClaim(
      "I restarted the bridge and it's running.",
      NO_TOOLS,
    );
    expect(result).not.toBeNull();
  });

  it("flags 'npm run check passed' with no tool called", () => {
    const result = checkUnmatchedActionClaim("npm run check passed.", NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'The check passes.' with no tool called", () => {
    const result = checkUnmatchedActionClaim("The check passes.", NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'I verified the dashboard works.' with no tool called", () => {
    const result = checkUnmatchedActionClaim(
      "I verified the dashboard works.",
      NO_TOOLS,
    );
    expect(result).not.toBeNull();
  });

  it("flags 'tests passed' with no tool called", () => {
    const result = checkUnmatchedActionClaim("All tests passed.", NO_TOOLS);
    expect(result).not.toBeNull();
  });

  it("flags 'I ran the build' / 'I executed' / 'I validated' / 'build succeeded'", () => {
    expect(checkUnmatchedActionClaim("I ran the build.", NO_TOOLS)).not.toBeNull();
    expect(checkUnmatchedActionClaim("I executed the migration.", NO_TOOLS)).not.toBeNull();
    expect(checkUnmatchedActionClaim("I validated the config.", NO_TOOLS)).not.toBeNull();
    expect(checkUnmatchedActionClaim("The build succeeded.", NO_TOOLS)).not.toBeNull();
  });

  // ── no false negative when the matching tool WAS called ──

  it("does NOT flag 'I restarted the bridge.' when process_restart was called", () => {
    const result = checkUnmatchedActionClaim(
      "I restarted the bridge.",
      new Set(["process_restart"]),
    );
    expect(result).toBeNull();
  });

  it("does NOT flag 'I ran the build' when bash was called", () => {
    const result = checkUnmatchedActionClaim(
      "I ran the build.",
      new Set(["bash"]),
    );
    expect(result).toBeNull();
  });

  // ── no false positive on benign prose ──

  it("does NOT flag a sentence that merely names a noun ('Here is the restart procedure.')", () => {
    const result = checkUnmatchedActionClaim(
      "Here is the restart procedure.",
      NO_TOOLS,
    );
    expect(result).toBeNull();
  });

  it("does NOT flag 'The file looks correct.'", () => {
    const result = checkUnmatchedActionClaim("The file looks correct.", NO_TOOLS);
    expect(result).toBeNull();
  });

  it("does NOT flag bare 'I checked the docs.' / 'I tested the assumption.' (deliberately excluded verbs)", () => {
    expect(checkUnmatchedActionClaim("I checked the docs.", NO_TOOLS)).toBeNull();
    expect(checkUnmatchedActionClaim("I tested the assumption mentally.", NO_TOOLS)).toBeNull();
  });
});

// Folded in from the retired hallucination-check middleware (2026-07-10): an
// invented tool ID ("Job ID: 5a0fb8ae", "sched_abc123") presented with no
// ID-producing tool call is a fabricated artifact even without an action verb.
describe("checkUnmatchedActionClaim — invented tool IDs", () => {
  it("flags a prefix-style ID with no ID-producing tool called", () => {
    const result = checkUnmatchedActionClaim(
      "Your mission is set up under sched_x9k2mf41.",
      NO_TOOLS,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("presented a tool ID");
  });

  it("flags 'Job ID: 5a0fb8ae' with no ID-producing tool called", () => {
    const result = checkUnmatchedActionClaim(
      "All done. Job ID: 5a0fb8ae",
      NO_TOOLS,
    );
    expect(result).not.toBeNull();
  });

  it("does NOT flag an ID when an ID-producing tool actually ran", () => {
    const result = checkUnmatchedActionClaim(
      "Scheduled it — Job ID: 5a0fb8ae",
      new Set(["cron_create"]),
    );
    expect(result).toBeNull();
  });

  it("does NOT flag an ID inside a code block (quoted sample, not a claim)", () => {
    const result = checkUnmatchedActionClaim(
      "You could run it like this:\n```\nlax jobs show sched_x9k2mf41\n```\nWant me to?",
      NO_TOOLS,
    );
    expect(result).toBeNull();
  });
});

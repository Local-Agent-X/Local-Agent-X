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

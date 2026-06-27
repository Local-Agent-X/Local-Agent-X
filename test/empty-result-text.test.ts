/**
 * Regression guard for EMPTY_RESULT_RE (src/errors/classifier.ts), the
 * "0 results" pattern the dead-end detector keys on. glob emits
 * "No files matched." which the regex used to miss — so a glob spin never
 * incremented the dead-end counter. grep's "No matches found." must stay
 * matched (no regression).
 */
import { describe, expect, it } from "vitest";

import { isEmptyResultText } from "../src/errors/classifier.js";

describe("isEmptyResultText — empty tool-result detection", () => {
  it("matches glob's empty output (was the gap)", () => {
    expect(isEmptyResultText("No files matched.")).toBe(true);
  });

  it("still matches grep's empty output (no regression)", () => {
    expect(isEmptyResultText("No matches found.")).toBe(true);
  });

  it("matches the other empty shapes", () => {
    expect(isEmptyResultText("No results")).toBe(true);
    expect(isEmptyResultText("0 results")).toBe(true);
    expect(isEmptyResultText("(no output)")).toBe(true);
  });

  it("does not match a real result", () => {
    expect(isEmptyResultText("Found 3 files: a.ts, b.ts, c.ts")).toBe(false);
    expect(isEmptyResultText("src/index.ts:42: const x = 1")).toBe(false);
  });
});

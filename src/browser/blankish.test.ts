import { describe, it, expect } from "vitest";
import { isBlankish } from "./blankish.js";

// isBlankish gates acquirePage's tab adoption: a "blankish" tab is reused
// instead of opening a fresh one. Miss a new-tab URL variant and the first
// navigation strands the real new-tab page and opens a second tab.
describe("isBlankish — adoptable blank-tab detection", () => {
  it("treats chrome://new-tab-page (modern Chrome NTP) as blank", () => {
    // Regression: only chrome://newtab (the redirect alias) was matched, so a
    // fresh Chrome whose initial tab is the real NTP WebUI (chrome://new-tab-page/)
    // wasn't adopted — the first nav opened a stray extra tab.
    expect(isBlankish("chrome://new-tab-page/")).toBe(true);
    expect(isBlankish("chrome://new-tab-page")).toBe(true);
    // startsWith also covers the third-party NTP variant.
    expect(isBlankish("chrome://new-tab-page-third-party/")).toBe(true);
  });

  it("still treats the classic blank URLs as blank", () => {
    expect(isBlankish("")).toBe(true);
    expect(isBlankish("about:blank")).toBe(true);
    expect(isBlankish("chrome://newtab")).toBe(true);
    expect(isBlankish("chrome://newtab/")).toBe(true);
  });

  it("does NOT treat a real page as blank", () => {
    expect(isBlankish("https://example.com/")).toBe(false);
    expect(isBlankish("http://127.0.0.1:7007/")).toBe(false);
    expect(isBlankish("chrome://settings")).toBe(false);
  });
});

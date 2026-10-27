import { describe, it, expect } from "vitest";
import { failingCheckNames } from "./failing-checks.js";

// The names come from each runner's per-failure line, real output trimmed to
// what matters; summary lines whose counts change between runs never count.

describe("failingCheckNames", () => {
  it("node --test (spec), each failure once, the section header and durations dropped", () => {
    const out = [
      "✔ toggle opens and closes the menu (0.4209ms)",
      "✖ tapping a link closes the menu (0.8199ms)",
      "✖ button reads Close while open and Menu while closed (0.1717ms)",
      "ℹ tests 3", "ℹ fail 2", "",
      "✖ failing tests:", "",
      "test at test\nav.test.js:13:1",
      "✖ tapping a link closes the menu (0.8199ms)",
      "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    ].join("\r\n");
    expect(failingCheckNames(out)).toEqual(["tapping a link closes the menu", "button reads Close while open and Menu while closed"]);
  });

  it("TAP", () => {
    const out = "ok 1 - toggle\nnot ok 2 - tapping a link closes the menu\n# fail 1\nnot ok 3 - skipped one # SKIP\n";
    expect(failingCheckNames(out)).toEqual(["tapping a link closes the menu", "skipped one"]);
  });

  it("vitest, colored", () => {
    const out = "\x1b[31m × \x1b[39mnav > closes the menu 3ms\n FAIL  test/nav.test.ts > nav > closes the menu\n Tests  1 failed | 2 passed";
    expect(failingCheckNames(out)).toEqual(["nav > closes the menu", "test/nav.test.ts > nav > closes the menu"]);
  });

  it("jest, pytest, unittest, go, cargo", () => {
    expect(failingCheckNames("  ● nav › closes the menu\nTests: 1 failed, 2 passed")).toEqual(["nav › closes the menu"]);
    expect(failingCheckNames("FAILED tests/test_nav.py::test_close - AssertionError\n1 failed, 2 passed")).toEqual(["tests/test_nav.py::test_close"]);
    expect(failingCheckNames("FAIL: test_close (test_nav.NavTest.test_close)\nFAILED (failures=1)")).toEqual(["test_close (test_nav.NavTest.test_close)"]);
    expect(failingCheckNames("--- FAIL: TestClose (0.00s)\nFAIL\tnav\t0.01s")).toEqual(["TestClose"]);
    expect(failingCheckNames("test nav::close ... FAILED\ntest result: FAILED. 2 passed; 1 failed")).toEqual(["nav::close"]);
  });

  it("tsc keys an error by file and message, not by where the line moved to", () => {
    const before = failingCheckNames("src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    const after = failingCheckNames("src/a.ts(9,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(after).toEqual(before);
    expect(failingCheckNames("src/a.ts:9:5 - error TS2304: Cannot find name 'x'.")).toEqual(["src/a.ts: TS2304: Cannot find name 'x'."]);
  });

  it("output no runner pattern recognizes names nothing", () => {
    expect(failingCheckNames("Segmentation fault\nnpm ERR! Test failed.")).toEqual([]);
  });
});

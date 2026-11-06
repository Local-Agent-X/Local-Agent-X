// The failing tests a failed run names, read from each runner's default report
// (test-failure-summary.ts): name, file:line and the first line of why.
import { describe, it, expect } from "vitest";
import { failingTests, failingTestsSummary } from "./test-failure-summary.js";

// vitest's default reporter, as a real run printed it (colours on).
const VITEST = [
  "\x1b[31m ❯\x1b[39m src/tools/plan-mode-read-only.test.ts (13 tests | 1 failed) 15ms",
  "     × an always-allow covers the whole tool only for LAX's own bookkeeping 3ms",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  src/tools/plan-mode-read-only.test.ts > the other row-declared facts > an always-allow covers the whole tool",
  "AssertionError: expected [ Array(7) ] to deeply equal [ Array(5) ]",
  "",
  "- Expected",
  "+ Received",
  "",
  " ❯ src/tools/plan-mode-read-only.test.ts:108:42",
  "    106|   it(\"an always-allow\", () => {",
  "",
  "⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
  " Test Files  1 failed | 4 passed (5)",
].join("\n");

const JEST = [
  "FAIL src/chat/__tests__/reducer.test.ts",
  "  ● chatReducer › keeps the card",
  "",
  "    expect(received).toEqual(expected) // deep equality",
  "",
  "      121 |     ]);",
  "    > 123 |     expect(lastAssistant(state).tools[0]?.card).toEqual(card);",
  "",
  "      at Object.<anonymous> (src/chat/__tests__/reducer.test.ts:123:50)",
  "",
  "  ● Console",
  "",
  "    console.warn",
  "Summary of all failing tests",
  "FAIL src/chat/__tests__/reducer.test.ts",
  "  ● chatReducer › keeps the card",
  "    expect(received).toEqual(expected) // deep equality",
  "Tests:       1 failed, 611 passed, 612 total",
].join("\n");

const PYTEST = [
  "tests/test_math.py:12: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_math.py::test_add - assert 1 == 2",
  "FAILED tests/test_io.py::test_read",
  "========================= 2 failed, 3 passed in 0.12s ==========================",
].join("\n");

describe("failingTests", () => {
  it("reads vitest's failure: the test, its line, and why", () => {
    expect(failingTests(VITEST)).toEqual([{
      name: "src/tools/plan-mode-read-only.test.ts > the other row-declared facts > an always-allow covers the whole tool",
      at: "src/tools/plan-mode-read-only.test.ts:108",
      message: "AssertionError: expected [ Array(7) ] to deeply equal [ Array(5) ]",
    }]);
  });

  it("reads jest's, once though jest repeats it, and not the Console block", () => {
    expect(failingTests(JEST)).toEqual([{
      name: "chatReducer › keeps the card",
      at: "src/chat/__tests__/reducer.test.ts:123",
      message: "expect(received).toEqual(expected) // deep equality",
    }]);
  });

  it("reads pytest's short summary, with the line where the detail names one", () => {
    expect(failingTests(PYTEST)).toEqual([
      { name: "tests/test_math.py::test_add", at: "tests/test_math.py:12", message: "assert 1 == 2" },
      { name: "tests/test_io.py::test_read", at: "tests/test_io.py" },
    ]);
  });

  it("names nothing for output that is not a test report", () => {
    expect(failingTests("npm ERR! missing script: build\nFAILED to start")).toEqual([]);
    expect(failingTestsSummary("tsc: error TS2322 in src/a.ts")).toBeNull();
  });
});

describe("failingTestsSummary", () => {
  it("lists them for the head of the result", () => {
    expect(failingTestsSummary(PYTEST)).toBe(
      "Failing tests (2):\n1. tests/test_math.py::test_add\n   at tests/test_math.py:12\n   assert 1 == 2\n" +
      "2. tests/test_io.py::test_read\n   at tests/test_io.py",
    );
  });
});

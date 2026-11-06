// A failed test run through the real bash tool: its result opens with the failing
// tests (test-failure-summary.ts, wired in shell-tool.ts failureNotices) ahead of
// the runner's own report, and a passing run or any other failure gets no list.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bashTool } = await import("./shell-tool.js");

// About the result's text, not confinement: the host shell, as the other real-run
// bash tests use (shell-secret-env.test.ts says why the cage cannot start here).
let prevSandbox: string | undefined;
beforeAll(() => { prevSandbox = process.env.LAX_SANDBOX; process.env.LAX_SANDBOX = "host"; });
afterAll(() => {
  if (prevSandbox === undefined) delete process.env.LAX_SANDBOX;
  else process.env.LAX_SANDBOX = prevSandbox;
});

const dir = mkdtempSync(join(tmpdir(), "lax-failing-tests-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A script that prints `report` as a test runner would and exits with `code`. */
function runner(name: string, report: string, code: number): string {
  const report_ = join(dir, `${name}.txt`).replace(/\\/g, "/");
  const script = join(dir, `${name}.sh`).replace(/\\/g, "/");
  writeFileSync(report_, report);
  writeFileSync(script, `cat "${report_}"\nexit ${code}\n`);
  return `sh "${script}"`;
}

const VITEST_FAIL = [
  " ❯ src/math.test.ts (2 tests | 1 failed) 4ms",
  "     × adds 2ms",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  src/math.test.ts > math > adds",
  "AssertionError: expected 3 to be 4 // Object.is equality",
  "",
  " ❯ src/math.test.ts:7:19",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 1 passed (2)",
  "",
].join("\n");

describe("bash: a failed test run opens with its failing tests", () => {
  it("lists the test, where it failed and why, before the runner's report", async () => {
    const result = await bashTool.execute({ command: runner("vitest-fail", VITEST_FAIL, 1) });
    expect(result.isError).toBe(true);
    const text = String(result.content);
    const list = text.indexOf("Failing tests (1):");
    expect(list).toBeGreaterThanOrEqual(0);
    expect(text).toContain("1. src/math.test.ts > math > adds\n   at src/math.test.ts:7\n   AssertionError: expected 3 to be 4");
    // The list comes first; the runner's own report follows it, untouched.
    expect(list).toBeLessThan(text.indexOf(" Test Files  1 failed"));
    expect(result.metadata?.exit_code).toBe(1);
  });

  it("a passing run and a failure that is not a test run get no list", async () => {
    const passed = await bashTool.execute({ command: runner("vitest-pass", " Test Files  1 passed (1)\n", 0) });
    expect(String(passed.content)).not.toContain("Failing tests");
    const other = await bashTool.execute({ command: runner("npm-fail", "npm ERR! missing script: test\n", 1) });
    expect(other.isError).toBe(true);
    expect(String(other.content)).not.toContain("Failing tests");
  });
});

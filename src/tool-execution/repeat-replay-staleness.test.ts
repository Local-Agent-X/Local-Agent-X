/**
 * A repeated call may only be answered from cache if nothing since could have
 * changed the answer.
 *
 * The session-repeat guard returned a prior identical call's result "without
 * re-executing" no matter what had happened in between. So a coding loop —
 * run the tests, edit the code, run the SAME test command — was handed the
 * first run's failing output, and the model concluded its fix had not worked.
 * The same held for read → edit → read. Seen as a replayed `read` in muse's
 * grade-school run (2026-09-17, with bash calls in between).
 */
import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { findPriorIdenticalResult } from "./resolve-tool.js";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls: ReturnType<typeof call>[]) =>
  ({ role: "assistant", content: null, tool_calls: calls }) as unknown as ChatCompletionMessageParam;
const result = (id: string, content: string) =>
  ({ role: "tool", tool_call_id: id, content }) as unknown as ChatCompletionMessageParam;

const TEST = { command: "python -m unittest grade_school_test" };
const READ = { path: "grade_school.py" };
const now = (name: string, args: Record<string, unknown>) => ({ id: "now", name, arguments: JSON.stringify(args) });

describe("a replay never crosses a state change", () => {
  it("test → edit → same test re-executes (the fix must be seen)", () => {
    const history = [
      assistant(call("t1", "bash", TEST)), result("t1", "[error, exit_code=1] FAILED (failures=3)"),
      assistant(call("e1", "edit", { path: "grade_school.py", old_string: "pass", new_string: "return []" })), result("e1", "Edited"),
    ];
    expect(findPriorIdenticalResult(now("bash", TEST), history)).toBeNull();
  });

  it("read → write → same read re-executes", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "class School:\n    pass"),
      assistant(call("w1", "write", { path: "grade_school.py", content: "x" })), result("w1", "Wrote"),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)).toBeNull();
  });

  it("read → any shell command → same read re-executes (a shell can change anything)", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "old contents"),
      assistant(call("b1", "bash", { command: "ls" })), result("b1", "grade_school.py"),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)).toBeNull();
  });

  it("a mutation earlier in the SAME batch still voids the replay", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "old contents"),
      assistant(call("w1", "write", { path: "grade_school.py", content: "x" }), call("now", "read", READ)),
      result("w1", "Wrote"),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)).toBeNull();
  });

  it("calls AFTER the current one in its batch have not run, and do not count", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "contents"),
      assistant(call("now", "read", READ), call("w1", "write", { path: "grade_school.py", content: "x" })),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)?.result).toBe("contents");
  });
});

describe("the guard still does its job when nothing changed", () => {
  it("an immediate identical repeat is answered from cache", () => {
    const history = [assistant(call("r1", "read", READ)), result("r1", "contents")];
    expect(findPriorIdenticalResult(now("read", READ), history)?.result).toBe("contents");
  });

  it("read-only calls in between do not void it", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "contents"),
      assistant(call("g1", "glob", { pattern: "*.py" })), result("g1", "grade_school.py"),
      assistant(call("s1", "grep", { pattern: "School" })), result("s1", "1 match"),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)?.result).toBe("contents");
  });

  it("the newest identical call is the one replayed", () => {
    const history = [
      assistant(call("r1", "read", READ)), result("r1", "old"),
      assistant(call("w1", "write", { path: "grade_school.py", content: "x" })), result("w1", "Wrote"),
      assistant(call("r2", "read", READ)), result("r2", "new"),
    ];
    expect(findPriorIdenticalResult(now("read", READ), history)?.result).toBe("new");
  });
});

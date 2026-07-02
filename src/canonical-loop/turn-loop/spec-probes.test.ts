import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  classifyProbeRun,
  runSpecProbeGate,
  getSpecProbeRetries,
  clearSpecProbeStateForOp,
  _resetSpecProbeState,
  type ProbeVerdict,
} from "./spec-probes.js";
import type { OracleProbe } from "../../classifiers/oracle-probe-gen.js";
import type { Op } from "../../ops/types.js";

const op = (id: string) => ({ id } as Op);
const PROBE: OracleProbe = { language: "python", script: "assert answer('x') == 5" };

// A generator/exec pair the gate calls through opts, so no live model or shell.
const genOk = vi.fn(async () => PROBE);
const execWith = (verdict: ProbeVerdict, output = "") => vi.fn(async () => ({ verdict, output }));

beforeEach(() => {
  _resetSpecProbeState();
  vi.clearAllMocks();
});

describe("classifyProbeRun — the anti-false-nag validity filter", () => {
  it("clean exit is a pass", () => {
    expect(classifyProbeRun("ok", "")).toBe("pass");
  });

  it("a tripped spec assertion is the only thing counted red", () => {
    expect(classifyProbeRun("error", "Traceback (most recent call last):\n  ...\nAssertionError")).toBe("red");
    expect(classifyProbeRun("error", "AssertionError: expected 5 got 6")).toBe("red");
    // A bare non-zero exit with no authoring-miss signature (e.g. `raise SystemExit`) is a real failure.
    expect(classifyProbeRun("error", "FAIL: unknown operation not handled")).toBe("red");
  });

  it("every implementation-blind authoring miss degrades to INVALID, never red", () => {
    // Wrong module-name guess / code doesn't import.
    expect(classifyProbeRun("error", "ModuleNotFoundError: No module named 'wordy'")).toBe("invalid");
    expect(classifyProbeRun("error", "ImportError: cannot import name 'answer'")).toBe("invalid");
    // Wrong symbol / attribute / signature guess.
    expect(classifyProbeRun("error", "AttributeError: module 'wordy' has no attribute 'answer'")).toBe("invalid");
    expect(classifyProbeRun("error", "NameError: name 'answer' is not defined")).toBe("invalid");
    expect(classifyProbeRun("error", "TypeError: answer() takes 1 positional argument but 2 were given")).toBe("invalid");
    // Solution / probe doesn't parse.
    expect(classifyProbeRun("error", "SyntaxError: invalid syntax")).toBe("invalid");
    // Node can't load the file (TS solution, wrong ext).
    expect(classifyProbeRun("error", "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './transpose.js'")).toBe("invalid");
    expect(classifyProbeRun("error", "TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension \".ts\"")).toBe("invalid");
    // Interpreter/command missing.
    expect(classifyProbeRun("error", "python3: command not found")).toBe("invalid");
    expect(classifyProbeRun("error", "sh: ./run: No such file or directory")).toBe("invalid");
  });

  it("environmental (timeout/blocked/aborted) is never a spec miss", () => {
    expect(classifyProbeRun("timeout", "Command timed out after 30s.")).toBe("invalid");
    expect(classifyProbeRun("blocked", "sandbox denied")).toBe("invalid");
    expect(classifyProbeRun("error", "Aborted")).toBe("invalid");
  });
});

describe("runSpecProbeGate", () => {
  it("passes → no retry, no nudge", async () => {
    const r = await runSpecProbeGate(op("a"), { editedPaths: ["/proj/wordy.py"], generate: genOk, exec: execWith("pass") });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
  });

  it("a real assertion failure suppresses done and nudges with the probe output", async () => {
    const r = await runSpecProbeGate(op("b"), {
      editedPaths: ["/proj/wordy.py"],
      generate: genOk,
      exec: execWith("red", "AssertionError: answer('What is 5?') was 0, not 5"),
    });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("acceptance check");
    expect(r.nudge).toContain("AssertionError");
    expect(getSpecProbeRetries("b")).toBe(1);
  });

  it("caps retries at 2, then goes silent", async () => {
    const exec = execWith("red", "AssertionError");
    const args = { editedPaths: ["/proj/wordy.py"], generate: genOk, exec };
    expect((await runSpecProbeGate(op("c"), args)).shouldRetry).toBe(true); // 1
    expect((await runSpecProbeGate(op("c"), args)).shouldRetry).toBe(true); // 2
    const third = await runSpecProbeGate(op("c"), args);
    expect(third.shouldRetry).toBe(false); // capped
    expect(getSpecProbeRetries("c")).toBe(2);
  });

  it("an INVALID probe never nudges AND is forgotten so it isn't re-run", async () => {
    const exec = execWith("invalid", "ModuleNotFoundError: No module named 'wordy'");
    const args = { editedPaths: ["/proj/wordy.py"], generate: genOk, exec };
    const first = await runSpecProbeGate(op("d"), args);
    expect(first.shouldRetry).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    // Second done-claim: the dud is cached as null, so we neither regenerate nor re-run it.
    const second = await runSpecProbeGate(op("d"), args);
    expect(second.shouldRetry).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(genOk).toHaveBeenCalledTimes(1);
  });

  it("degrades to no-op when the author abstains (probe null) or nothing was edited", async () => {
    const genNull = vi.fn(async () => null);
    const exec = execWith("red", "AssertionError");
    const abstain = await runSpecProbeGate(op("e"), { editedPaths: ["/proj/wordy.py"], generate: genNull, exec });
    expect(abstain.shouldRetry).toBe(false);
    expect(exec).not.toHaveBeenCalled();

    const noEdits = await runSpecProbeGate(op("f"), { editedPaths: [], generate: genOk, exec });
    expect(noEdits.shouldRetry).toBe(false);
    expect(genOk).not.toHaveBeenCalled();
  });

  it("generates the probe once per op and reuses it across retries", async () => {
    const exec = execWith("red", "AssertionError");
    const args = { editedPaths: ["/proj/wordy.py"], generate: genOk, exec };
    await runSpecProbeGate(op("g"), args);
    await runSpecProbeGate(op("g"), args);
    expect(genOk).toHaveBeenCalledTimes(1);
  });

  it("clearSpecProbeStateForOp resets the counter and the cache", async () => {
    const args = { editedPaths: ["/proj/wordy.py"], generate: genOk, exec: execWith("red", "AssertionError") };
    await runSpecProbeGate(op("h"), args);
    expect(getSpecProbeRetries("h")).toBe(1);
    clearSpecProbeStateForOp("h");
    expect(getSpecProbeRetries("h")).toBe(0);
    await runSpecProbeGate(op("h"), args);
    expect(genOk).toHaveBeenCalledTimes(2); // regenerated after clear
  });
});

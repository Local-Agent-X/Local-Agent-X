import { describe, it, expect } from "vitest";
import { startFailureSummary } from "./handlers.js";
import { startupBudgetMs, tierById } from "./tiers.js";

// Regression lock for the dialog that lied.
//
// A crashed sidecar and a slow-starting one used to collapse into the same
// `false`, so the API answered a process that died 0.7s in with "didn't report
// healthy within 3 min — but pid ? is still running. Try again in 30s." Every
// clause was wrong: it hadn't been 3 minutes, nothing was running, and
// retrying could not work. The `pid ?` was the exit handler having already
// dropped the entry. Meanwhile the real reason (ModuleNotFoundError: numpy)
// sat in the sidecar log the whole time.

describe("startFailureSummary", () => {
  it("reports a crash as a crash — no timeout claim, no retry advice", () => {
    const msg = startFailureSummary("lite", {
      ok: false,
      reason: "exited",
      exitCode: 1,
      logTail: "ModuleNotFoundError: No module named 'numpy'",
    });
    expect(msg).toContain("crashed on startup");
    expect(msg).toContain("exit code 1");
    expect(msg).not.toContain("3 min");
    expect(msg).not.toContain("still running");
    expect(msg).not.toMatch(/try (start )?again/i);
  });

  it("surfaces the crash reason from the log instead of burying it in a file", () => {
    const msg = startFailureSummary("lite", {
      ok: false,
      reason: "exited",
      exitCode: 1,
      logTail: "ModuleNotFoundError: No module named 'numpy'",
    });
    expect(msg).toContain("ModuleNotFoundError: No module named 'numpy'");
    expect(msg).toContain("lite.log");
  });

  it("names the tier's own log, not a hardcoded one", () => {
    const msg = startFailureSummary("studio", { ok: false, reason: "exited", exitCode: 9, logTail: "" });
    expect(msg).toContain("studio.log");
    expect(msg).not.toContain("lite.log");
  });

  it("still reports a real timeout as a timeout, with the pid and retry advice", () => {
    const msg = startFailureSummary("lite", { ok: false, reason: "timeout", pid: 4242, logTail: "loading whisper..." });
    expect(msg).toContain("3 min");
    expect(msg).toContain("4242");
    expect(msg).toContain("still running");
    expect(msg).toMatch(/try start again/i);
    expect(msg).not.toContain("crashed");
  });

  it("waits each tier's own measured cold start, not one budget for all", () => {
    // VoxCPM's log records up to ~207s from spawn to /healthz (184s load +
    // 23s pre-warm); a 3-min budget reported that healthy start as a failure.
    const vox = tierById("studio-vox")!;
    expect(startupBudgetMs(vox)).toBeGreaterThan(207_000);
    const msg = startFailureSummary("studio-vox", { ok: false, reason: "timeout", pid: 1, logTail: "" });
    expect(msg).toContain(`${Math.round(startupBudgetMs(vox) / 60_000)} min`);
    expect(msg).not.toContain("3 min");
  });

  it("handles an unknown exit code and an empty log without emitting 'undefined'", () => {
    const msg = startFailureSummary("lite", { ok: false, reason: "exited", exitCode: null, logTail: "" });
    expect(msg).toContain("unknown");
    expect(msg).not.toContain("undefined");
    expect(msg).not.toContain("Last log lines");
  });
});

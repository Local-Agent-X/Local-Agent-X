import { describe, it, expect } from "vitest";
import {
  collectToolFailures,
  formatFailureNudgeForModel,
  shouldNudgeForFailures,
} from "../src/canonical-loop/turn-loop/tool-failure-summary.js";

function tm(text: string, toolCallId = "call-1") {
  return { role: "tool_result" as const, content: { text, toolCallId } };
}

describe("collectToolFailures", () => {
  it("returns no failures when every tool was ok", () => {
    const r = collectToolFailures(
      [tm("[ok] Wrote /x/y"), tm("[ok] Edited /x/y", "call-2")],
      [{ tool: "write" }, { tool: "edit", toolCallId: "call-2" }],
    );
    expect(r.failures).toEqual([]);
  });

  it("captures error / blocked / timeout statuses", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string found 2 times"),
        tm("[blocked, recovery=\"x\"] policy refused", "call-2"),
        tm("[timeout, duration_ms=60000] hung", "call-3"),
      ],
      [{ tool: "edit" }, { tool: "bash" }, { tool: "http_request" }],
    );
    expect(r.failures).toHaveLength(3);
    expect(r.failures[0].tool).toBe("edit");
    expect(r.failures[1].tool).toBe("bash");
    expect(r.failures[2].tool).toBe("http_request");
  });

  it("counts declined as a failure and tags it (user said no ≠ tool broken)", () => {
    const r = collectToolFailures(
      [tm("[declined]\nDECLINED by user: bash. Do not retry the same call — adjust your approach or ask the user.")],
      [{ tool: "bash" }],
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].tool).toBe("bash");
    expect(r.failures[0].declined).toBe(true);
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("excludes running (async-started) results", () => {
    const r = collectToolFailures(
      [tm("[running, session_id=s1] started; poll process_status")],
      [{ tool: "process_start" }],
    );
    expect(r.failures).toEqual([]);
  });

  it("strips the status header from the reason line", () => {
    const r = collectToolFailures(
      [tm("[error]\nold_string found 2 times in level.js")],
      [{ tool: "edit" }],
    );
    expect(r.failures[0].reason).not.toMatch(/^\[error\]/);
    expect(r.failures[0].reason).toMatch(/old_string found 2 times/);
  });

  it("treats legacy ok results (no status header) as ok", () => {
    const r = collectToolFailures(
      [tm("Wrote /a/b.txt")],
      [{ tool: "write" }],
    );
    expect(r.failures).toEqual([]);
  });
});

describe("shouldNudgeForFailures — gaslighting heuristic", () => {
  it("nudges when failures present and no successful mutation", () => {
    const r = collectToolFailures(
      [tm("[error] old_string not found")],
      [{ tool: "edit" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("does NOT nudge when failures coexist with a successful write (pixel-platformer case)", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string not found", "call-1"),
        tm("[error] old_string not found", "call-2"),
        tm("[error] old_string not found", "call-3"),
        tm("[error] old_string not found", "call-4"),
        tm("[ok] Wrote /workspace/apps/pixel-platformer/js/game.js", "call-5"),
      ],
      [{ tool: "edit" }, { tool: "edit" }, { tool: "edit" }, { tool: "edit" }, { tool: "write" }],
    );
    expect(r.hadSuccessfulMutation).toBe(true);
    expect(shouldNudgeForFailures(r)).toBe(false);
  });

  it("does NOT nudge when failures coexist with a successful edit", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string found 2 times", "call-1"),
        tm("[ok] Edited /foo.js", "call-2"),
      ],
      [{ tool: "edit" }, { tool: "edit" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(false);
  });

  it("STILL nudges when only read/grep/glob succeeded (model spamming reads after failed edits)", () => {
    const r = collectToolFailures(
      [
        tm("[error] old_string not found", "call-1"),
        tm("[ok] read file contents...", "call-2"),
        tm("[ok] grep results...", "call-3"),
      ],
      [{ tool: "edit" }, { tool: "read" }, { tool: "grep" }],
    );
    expect(r.hadSuccessfulMutation).toBe(false);
    expect(shouldNudgeForFailures(r)).toBe(true);
  });

  it("does NOT nudge when no failures (clean turn)", () => {
    const r = collectToolFailures(
      [tm("[ok] Wrote foo")],
      [{ tool: "write" }],
    );
    expect(shouldNudgeForFailures(r)).toBe(false);
  });
});

describe("formatFailureNudgeForModel", () => {
  it("returns empty when no failures", () => {
    expect(formatFailureNudgeForModel({ failures: [] })).toBe("");
  });

  it("tells the model not to claim done and lists the failed calls", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "edit", reason: "old_string found 2 times in level.js" },
        { tool: "bash", reason: "PowerShell quoting error" },
      ],
    });
    expect(msg).toMatch(/2 tool calls/);
    expect(msg).toMatch(/Do NOT claim the task is done/);
    expect(msg).toMatch(/edit/);
    expect(msg).toMatch(/bash/);
    expect(msg).toMatch(/old_string found 2 times/);
    expect(msg).toMatch(/PowerShell quoting/);
  });

  it("gives declined failures distinct wording: adjust or ask, don't immediately repeat", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "bash", reason: "DECLINED by user: bash", declined: true }],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/declined by the user/);
    expect(msg).toMatch(/Do not immediately repeat that call/);
    expect(msg).toMatch(/tool is NOT broken/);
    expect(msg).toMatch(/adjust your approach or ask the user/);
    // The designed re-raise flow stays open: "proceed" in chat → re-request.
    expect(msg).toMatch(/you may request approval again/);
  });

  it("an all-declined failure set gets a header that does NOT urge retrying", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "bash", reason: "DECLINED by user: bash", declined: true },
        { tool: "delete_file", reason: "DECLINED by user: delete_file", declined: true },
      ],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/declined by the user/);
    expect(msg).not.toMatch(/retried successfully/);
    expect(msg).not.toMatch(/recovery hints/);
    expect(msg).toMatch(/do NOT retry the declined calls as-is/);
  });

  it("a mixed declined+error set keeps the retry-oriented header (errors ARE retryable)", () => {
    const msg = formatFailureNudgeForModel({
      failures: [
        { tool: "edit", reason: "old_string not found" },
        { tool: "bash", reason: "DECLINED by user: bash", declined: true },
      ],
      hadSuccessfulMutation: false,
    });
    expect(msg).toMatch(/retried successfully/);
    expect(msg).toMatch(/declined by the user/);
  });

  it("does NOT add the declined note for ordinary errors", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "old_string not found" }],
      hadSuccessfulMutation: false,
    });
    expect(msg).not.toMatch(/declined/i);
  });

  it("uses singular wording for one failure", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "x" }],
    });
    expect(msg).toMatch(/1 tool call/);
    expect(msg).not.toMatch(/tool calls/);
  });

  it("is addressed to the model, not the user (no UI banner phrasing)", () => {
    const msg = formatFailureNudgeForModel({
      failures: [{ tool: "edit", reason: "x" }],
    });
    // Banner-style phrasing would say "the model's claims above" — that's
    // user-facing and has no place in a nudge addressed to the model.
    expect(msg).not.toMatch(/model's claims/);
    expect(msg).not.toMatch(/⚠/);
  });
});

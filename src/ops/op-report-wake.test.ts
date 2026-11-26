// The chat that started a background op is woken when it ends, so its agent
// reports it at once (the Home Remote build failed and the chat heard only a
// canned nudge two minutes later, 2026-11-16).
import { describe, it, expect, beforeEach, vi } from "vitest";

const { busy, handled } = vi.hoisted(() => ({
  busy: { value: false, release: null as null | (() => void) },
  handled: [] as Array<{ sessionId: string; message: string }>,
}));
vi.mock("../chat-ws/chat-handler.js", () => ({
  getChatHandler: () => (sessionId: string, message: string) => { handled.push({ sessionId, message }); },
}));
vi.mock("../session/turn-lock.js", () => ({
  hasActiveTurn: () => busy.value,
  onTurnRelease: (_s: string, cb: () => void) => { busy.release = cb; },
}));

import { wakeChatForEndedOp, opReportMessage, _flushOpReportWakeForTest, _resetOpReportWakeForTest } from "./op-report-wake.js";
import { pushPendingNotification, drainPendingNotifications } from "./pending-notifications.js";

const SESSION = "chat-abc";
function ended(opId: string, status: "completed" | "failed" = "failed") {
  pushPendingNotification(SESSION, { opId, status, summary: "smoke failed", filesChanged: [], task: `Build app "${opId}"`, completedAt: Date.now() });
  return { opId, task: `Build app "${opId}"`, status };
}

beforeEach(() => {
  _resetOpReportWakeForTest();
  drainPendingNotifications(SESSION);
  handled.length = 0;
  busy.value = false;
  busy.release = null;
});

describe("op report wake", () => {
  it("wakes an idle chat with an app-marked message naming the op and how it ended", () => {
    wakeChatForEndedOp(SESSION, ended("home-remote"));
    _flushOpReportWakeForTest(SESSION);
    expect(handled).toHaveLength(1);
    expect(handled[0].sessionId).toBe(SESSION);
    expect(handled[0].message).toContain("not typed by the user");
    expect(handled[0].message).toContain('"Build app "home-remote"" failed');
  });

  it("reports ops that end together in one turn", () => {
    wakeChatForEndedOp(SESSION, ended("a"));
    wakeChatForEndedOp(SESSION, ended("b", "completed"));
    _flushOpReportWakeForTest(SESSION);
    expect(handled).toHaveLength(1);
    expect(handled[0].message).toMatch(/"Build app "a"" failed[\s\S]*"Build app "b"" finished/);
  });

  it("waits out a running turn, then wakes nothing if that turn already took the result", () => {
    busy.value = true;
    wakeChatForEndedOp(SESSION, ended("x"));
    _flushOpReportWakeForTest(SESSION);
    expect(handled).toHaveLength(0);
    busy.value = false;
    drainPendingNotifications(SESSION); // the user's turn drained the queue
    busy.release?.();
    _flushOpReportWakeForTest(SESSION);
    expect(handled).toHaveLength(0);
  });

  it("wakes after a running turn ends when the result is still waiting", () => {
    busy.value = true;
    wakeChatForEndedOp(SESSION, ended("y"));
    _flushOpReportWakeForTest(SESSION);
    busy.value = false;
    busy.release?.();
    _flushOpReportWakeForTest(SESSION);
    expect(handled).toHaveLength(1);
  });

  it("never wakes a background job, sub-agent or worker session", () => {
    for (const s of ["dream-1", "cron-1", "mail-watch-1", "agent-1", "op_app_build_1"]) {
      wakeChatForEndedOp(s, { opId: "z", task: "t", status: "failed" });
      _flushOpReportWakeForTest(s);
    }
    expect(handled).toHaveLength(0);
  });

  it("asks for a short report and no work the user never asked for", () => {
    const text = opReportMessage([{ opId: "o", task: "t", status: "partial" }]);
    expect(text).toContain("stopped before finishing");
    expect(text).toContain("Do not start work the user never asked for");
  });

  // The chat that handed "install it and test it" to a worker reported that
  // the worker stopped early, then stopped itself (Label Check Sol, 2026-11-26).
  it("tells the chat to carry on with a request the ended work was part of", () => {
    const text = opReportMessage([{ opId: "o", task: "t", status: "completed" }]);
    expect(text).toContain("Reporting is not finishing");
    expect(text).not.toContain("still has these steps open");
  });

  it("names the plan steps still open, each on one clipped line", () => {
    const text = opReportMessage(
      [{ opId: "o", task: "t", status: "completed" }],
      ["Obtain and install\nthe current preview APK", "x".repeat(300)],
    );
    expect(text).toContain("  1. Obtain and install the current preview APK");
    expect(text).toContain(`  2. ${"x".repeat(100)}\n`);
    expect(text.indexOf("still has these steps open")).toBeLessThan(text.indexOf("Reporting is not finishing"));
  });
});

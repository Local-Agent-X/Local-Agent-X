/**
 * A worker control (Cancel / Resume / Pause from the phone's workers sheet) answers
 * the client with the whole worker list. A control that worked used to say nothing,
 * and a Dream run's events go to its own dream-* session, so the phone never heard
 * the run end and Cancel looked dead (2026-10-22).
 */
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

const control = vi.hoisted(() => ({
  opCancel: vi.fn(() => ({ ok: true })),
  opPause: vi.fn(() => ({ ok: true })),
  opResume: vi.fn(() => ({ ok: false, code: "not_paused" })),
}));
vi.mock("../canonical-loop/index.js", () => control);
const snapshot = vi.hoisted(() => ({ sendWorkersSnapshot: vi.fn(async () => {}) }));
vi.mock("./workers-snapshot.js", () => snapshot);

const { handleAgentControl } = await import("./agent-controls.js");

function socket(): { ws: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  return { ws: { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as WebSocket, sent };
}

describe("handleAgentControl answers with the worker list", () => {
  it("after a cancel that worked", async () => {
    const { ws } = socket();
    await handleAgentControl(ws, "op_memory_consolidation_1", "cancel");
    expect(control.opCancel).toHaveBeenCalledWith("op_memory_consolidation_1", "user-stop");
    expect(snapshot.sendWorkersSnapshot).toHaveBeenCalledWith(ws);
  });

  it("after a control that failed too, beside the error", async () => {
    snapshot.sendWorkersSnapshot.mockClear();
    const { ws, sent } = socket();
    await handleAgentControl(ws, "op_x", "resume");
    expect(sent).toEqual([expect.objectContaining({ type: "error", message: "resume failed: not_paused" })]);
    expect(snapshot.sendWorkersSnapshot).toHaveBeenCalledWith(ws);
  });
});

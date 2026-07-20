import { describe, expect, it, vi } from "vitest";
import {
  notifySessionEventObservers,
  sessionEventHighWater,
  sessionEventJournalSince,
  subscribeSessionEvents,
} from "./session-event-observers.js";

describe("session event observers", () => {
  it("isolates sessions, exceptions, and unsubscribe", () => {
    const a = vi.fn();
    const b = vi.fn(() => { throw new Error("observer failed"); });
    const offA = subscribeSessionEvents("a", a);
    const offB = subscribeSessionEvents("a", b);
    const other = vi.fn();
    const offOther = subscribeSessionEvents("b", other);

    expect(() => notifySessionEventObservers("a", { type: "error", message: "x" })).not.toThrow();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    offA();
    offB();
    offOther();
    notifySessionEventObservers("a", { type: "error", message: "late" });
    expect(a).toHaveBeenCalledOnce();
  });

  it("advances a session-local high-water before delivering each event", () => {
    const versions: number[] = [];
    const off = subscribeSessionEvents("versioned", (_event, version) => {
      versions.push(version);
      expect(sessionEventHighWater("versioned")).toBe(version);
    });
    notifySessionEventObservers("versioned", { type: "error", message: "one" });
    notifySessionEventObservers("versioned", { type: "error", message: "two" });
    expect(versions).toEqual([1, 2]);
    off();
    expect(sessionEventHighWater("versioned")).toBe(0);
  });

  it("journals exact versions after a capture boundary", () => {
    const off = subscribeSessionEvents("journaled", () => {});
    notifySessionEventObservers("journaled", { type: "error", message: "before" });
    const boundary = sessionEventHighWater("journaled");
    notifySessionEventObservers("journaled", { type: "error", message: "after one" });
    notifySessionEventObservers("journaled", { type: "error", message: "after two" });
    expect(sessionEventJournalSince("journaled", boundary)).toEqual([
      { version: 2, event: { type: "error", message: "after one" } },
      { version: 3, event: { type: "error", message: "after two" } },
    ]);
    off();
  });

  it("bounds the reconciliation journal", () => {
    const off = subscribeSessionEvents("bounded", () => {});
    for (let i = 0; i < 140; i += 1) {
      notifySessionEventObservers("bounded", { type: "error", message: String(i) });
    }
    const journal = sessionEventJournalSince("bounded", 0);
    expect(journal).toHaveLength(128);
    expect(journal[0]?.version).toBe(13);
    expect(journal.at(-1)?.version).toBe(140);
    off();
  });
});

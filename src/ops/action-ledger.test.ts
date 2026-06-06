import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendActionLedger,
  readSessionActions,
  recentActions,
  type ActionLedgerEntry,
} from "./action-ledger.js";

let dir: string;
let prevEnv: string | undefined;

function entry(over: Partial<ActionLedgerEntry> = {}): ActionLedgerEntry {
  return {
    ts: "2026-06-06T10:00:00.000Z",
    sessionId: "sess-1",
    opId: "op_chat_turn_1",
    opType: "chat_turn",
    turnIdx: 0,
    task: "do the thing",
    actions: [{ tool: "edit", status: "ok" }],
    terminalReason: "done",
    ...over,
  };
}

beforeEach(() => {
  prevEnv = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-ledger-"));
  process.env.LAX_DATA_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("action-ledger IO", () => {
  it("round-trips an entry through append → read", () => {
    appendActionLedger(entry());
    const rows = readSessionActions("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].actions[0]).toEqual({ tool: "edit", status: "ok" });
    expect(rows[0].opType).toBe("chat_turn");
  });

  it("skips tool-less turns (no noise)", () => {
    appendActionLedger(entry({ actions: [] }));
    expect(readSessionActions("sess-1")).toHaveLength(0);
    expect(existsSync(join(dir, "action-log"))).toBe(false);
  });

  it("skips entries with no session", () => {
    appendActionLedger(entry({ sessionId: "" }));
    expect(readSessionActions("")).toHaveLength(0);
  });

  it("clips an overlong task", () => {
    appendActionLedger(entry({ task: "x".repeat(500) }));
    const rows = readSessionActions("sess-1");
    expect(rows[0].task!.length).toBeLessThanOrEqual(200);
  });

  it("isolates sessions and slugs path-hostile ids into safe filenames", () => {
    appendActionLedger(entry({ sessionId: "voice/../weird id", actions: [{ tool: "bash", status: "ok" }] }));
    appendActionLedger(entry({ sessionId: "sess-2", actions: [{ tool: "web_search", status: "ok" }] }));
    expect(readSessionActions("sess-2")).toHaveLength(1);
    const files = readdirSync(join(dir, "action-log"));
    expect(files.every(f => !f.includes("/") && !f.includes("..") && !f.includes(" "))).toBe(true);
  });

  it("limit keeps the most recent entries; sinceTs filters by time", () => {
    appendActionLedger(entry({ ts: "2026-06-06T09:00:00.000Z", actions: [{ tool: "a", status: "ok" }] }));
    appendActionLedger(entry({ ts: "2026-06-06T10:00:00.000Z", actions: [{ tool: "b", status: "ok" }] }));
    appendActionLedger(entry({ ts: "2026-06-06T11:00:00.000Z", actions: [{ tool: "c", status: "ok" }] }));

    const lastTwo = readSessionActions("sess-1", { limit: 2 });
    expect(lastTwo.map(e => e.actions[0].tool)).toEqual(["b", "c"]);

    const since = readSessionActions("sess-1", { sinceTs: "2026-06-06T10:30:00.000Z" });
    expect(since.map(e => e.actions[0].tool)).toEqual(["c"]);
  });

  it("recentActions flattens across entries and caps the total", () => {
    appendActionLedger(entry({ actions: [{ tool: "a", status: "ok" }, { tool: "b", status: "error" }] }));
    appendActionLedger(entry({ actions: [{ tool: "c", status: "ok" }] }));
    const flat = recentActions("sess-1", 2);
    expect(flat).toEqual([{ tool: "b", status: "error" }, { tool: "c", status: "ok" }]);
  });
});

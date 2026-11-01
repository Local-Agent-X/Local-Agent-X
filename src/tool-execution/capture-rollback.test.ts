/**
 * capture-rollback wiring: which calls copy files aside (every call whose
 * policy row says it writes or deletes a path, in every autonomy profile),
 * with the paths resolved the way the file tools resolve them, and which
 * calls tell the chat about a change it can undo.
 *
 * The snapshot mechanics live in autonomy/rollback.ts (tested there).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const { captureRollback } = vi.hoisted(() => ({ captureRollback: vi.fn() }));
vi.mock("../autonomy/rollback.js", () => ({ captureRollback }));

import { announceFileChanges, captureRollbackPhase } from "./capture-rollback.js";
import { CONTINUE } from "./context.js";
import type { ToolCallContext } from "./context.js";
import { resolveAgentPath } from "../workspace/paths.js";
import type { RollbackContract } from "../autonomy/rollback.js";

function ctx(name: string, args: Record<string, unknown>, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    tc: { id: "tc-1", name, arguments: JSON.stringify(args) },
    sessionId: "sess-1",
    operationId: "op-1",
    args,
    ...extra,
  } as unknown as ToolCallContext;
}

const contract = (artifacts: RollbackContract["artifacts"]): RollbackContract =>
  ({ toolCallId: "tc-1", tool: "write", sessionId: "sess-1", opId: "op-1", ts: 0, artifacts });

beforeEach(() => {
  captureRollback.mockReset();
  captureRollback.mockImplementation((_call, paths: string[]) => (paths.length ? contract([]) : null));
});

describe("captureRollbackPhase", () => {
  it("captures what a write will change, resolved the way the write tool resolves it", async () => {
    const c = ctx("write", { path: "src/app.ts", content: "x" });
    expect(await captureRollbackPhase(c)).toEqual(CONTINUE);
    expect(captureRollback).toHaveBeenCalledWith(
      { toolCallId: "tc-1", tool: "write", sessionId: "sess-1", opId: "op-1" },
      [resolveAgentPath("src/app.ts", "sess-1")],
    );
    expect(c.rollback).toBeDefined();
  });

  it.each([
    ["edit", { path: join("a", "b.ts"), old_string: "x", new_string: "y" }],
    ["delete_file", { path: "old.txt" }],
  ])("captures for %s too", async (name, args) => {
    await captureRollbackPhase(ctx(name, args));
    expect(captureRollback.mock.calls[0][1]).toHaveLength(1);
  });

  it("captures nothing for a call that writes no file", async () => {
    const c = ctx("read", { path: "src/app.ts" });
    await captureRollbackPhase(c);
    expect(captureRollback.mock.calls[0][1]).toEqual([]);
    expect(c.rollback).toBeUndefined();
  });

  it("never blocks the tool when capture throws", async () => {
    captureRollback.mockImplementation(() => { throw new Error("disk full"); });
    expect(await captureRollbackPhase(ctx("write", { path: "x.txt", content: "" }))).toEqual(CONTINUE);
  });
});

describe("announceFileChanges", () => {
  const changed = contract([
    { type: "file-backup", original: "/w/a.ts", backup: "/r/0-a.ts.bak" },
    { type: "created", original: "/w/b.ts" },
    { type: "none", reason: "folder" },
  ]);

  it("tells the chat which files a successful call changed, under its request", () => {
    const onEvent = vi.fn();
    announceFileChanges(ctx("write", {}, { rollback: changed, onEvent, result: { content: "ok" } }));
    expect(onEvent).toHaveBeenCalledWith({ type: "file_changes", sessionId: "sess-1", opId: "op-1", files: ["/w/a.ts", "/w/b.ts"] });
  });

  it.each([
    ["the call failed", { result: { content: "boom", isError: true } }],
    ["the call was blocked", { result: { content: "no", status: "blocked", metadata: { recovery: "", layer: "policy" } } }],
    ["the result was replayed, not run now", { result: { content: "ok" }, resultReused: "dedup-cache" }],
    ["nothing was captured", { result: { content: "ok" }, rollback: undefined }],
  ])("says nothing when %s", (_why, extra) => {
    const onEvent = vi.fn();
    announceFileChanges(ctx("write", {}, { rollback: changed, onEvent, ...(extra as Partial<ToolCallContext>) }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

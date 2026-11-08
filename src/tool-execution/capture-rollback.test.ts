/**
 * capture-rollback wiring: which calls copy files aside (every call whose
 * policy row says it writes or deletes a path, and every shell command, by the
 * files its text names), in every autonomy profile, with the paths resolved
 * the way the tools resolve them; and which calls tell the chat about a change
 * it can undo.
 *
 * The snapshot mechanics live in autonomy/rollback.ts (tested there).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureBeforeCall, recordCapture } = vi.hoisted(() => ({ captureBeforeCall: vi.fn(), recordCapture: vi.fn() }));
vi.mock("../autonomy/rollback.js", () => ({ captureBeforeCall, recordCapture }));

import { captureRollbackPhase, recordFileChanges } from "./capture-rollback.js";
import { CONTINUE } from "./context.js";
import type { ToolCallContext } from "./context.js";
import { resolveAgentPath } from "../workspace/paths.js";
import type { RollbackContract } from "../autonomy/rollback.js";

let opSeq = 0;
function ctx(name: string, args: Record<string, unknown>, extra: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    tc: { id: "tc-1", name, arguments: JSON.stringify(args) },
    sessionId: "sess-1",
    operationId: `op-${opSeq}`,
    args,
    ...extra,
  } as unknown as ToolCallContext;
}
const capturedPaths = (): string[] => captureBeforeCall.mock.calls.at(-1)![1];

const contract = (artifacts: RollbackContract["artifacts"]): RollbackContract =>
  ({ toolCallId: "tc-1", tool: "write", sessionId: "sess-1", opId: "op-1", ts: 0, artifacts });

let dir: string;
beforeEach(() => {
  opSeq++;
  dir = mkdtempSync(join(tmpdir(), "lax-capture-"));
  captureBeforeCall.mockReset();
  recordCapture.mockReset();
  captureBeforeCall.mockImplementation((call, paths: string[]) => (paths.length ? { call, ts: 0, entries: [] } : null));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("captureRollbackPhase: file tools", () => {
  it("captures what a write may change, resolved the way the write tool resolves it", async () => {
    const c = ctx("write", { path: "src/app.ts", content: "x" });
    expect(await captureRollbackPhase(c)).toEqual(CONTINUE);
    expect(captureBeforeCall).toHaveBeenCalledWith(
      { toolCallId: "tc-1", tool: "write", sessionId: "sess-1", opId: `op-${opSeq}` },
      [resolveAgentPath("src/app.ts", "sess-1")],
    );
    expect(c.rollback).toBeDefined();
  });

  it.each([
    ["edit", { path: join("a", "b.ts"), old_string: "x", new_string: "y" }],
    ["delete_file", { path: "old.txt" }],
  ])("captures for %s too", async (name, args) => {
    await captureRollbackPhase(ctx(name, args));
    expect(capturedPaths()).toHaveLength(1);
  });

  it("captures nothing for a call that writes no file", async () => {
    const c = ctx("read", { path: "src/app.ts" });
    await captureRollbackPhase(c);
    expect(capturedPaths()).toEqual([]);
    expect(c.rollback).toBeUndefined();
  });

  it("never blocks the tool when capture throws", async () => {
    captureBeforeCall.mockImplementation(() => { throw new Error("disk full"); });
    expect(await captureRollbackPhase(ctx("write", { path: "x.txt", content: "" }))).toEqual(CONTINUE);
  });
});

describe("captureRollbackPhase: shell commands, by the files they name", () => {
  const bash = (command: string) => ctx("bash", { command, _cwd: dir });

  it("a database it opens, with the WAL beside it that opening it can fold in and delete", async () => {
    writeFileSync(join(dir, "app.db"), "db"); writeFileSync(join(dir, "app.db-wal"), "wal");
    await captureRollbackPhase(bash(`sqlite3 app.db "select 1"`));
    expect(capturedPaths()).toEqual(expect.arrayContaining([join(dir, "app.db"), join(dir, "app.db-wal")]));
  });

  it("a file sed edits in place, and a file a redirect will create", async () => {
    writeFileSync(join(dir, "notes.txt"), "a");
    await captureRollbackPhase(bash("sed -i s/a/b/ notes.txt && echo done > out.txt"));
    expect(capturedPaths()).toEqual(expect.arrayContaining([join(dir, "notes.txt"), join(dir, "out.txt")]));
  });

  it("not a word that names no file", async () => {
    await captureRollbackPhase(bash("echo hello world"));
    expect(capturedPaths()).toEqual([]);
  });

  it("once per request for a file already on record, again for one a command left alone", async () => {
    writeFileSync(join(dir, "data.csv"), "1"); writeFileSync(join(dir, "run.py"), "print(1)");
    const first = bash("python run.py data.csv");
    await captureRollbackPhase(first);
    recordCapture.mockReturnValueOnce(contract([{ type: "file-backup", original: join(dir, "data.csv"), backup: "/r/0" }]));
    recordFileChanges(first);

    await captureRollbackPhase(bash("python run.py data.csv"));
    expect(capturedPaths()).toEqual([join(dir, "run.py")]);
  });
});

describe("recordFileChanges", () => {
  const changed = contract([
    { type: "file-backup", original: "/w/a.ts", backup: "/r/0-a.ts.bak" },
    { type: "created", original: "/w/b.ts" },
    { type: "none", reason: "folder" },
  ]);

  it("tells the chat which files the call changed, under its request", () => {
    const onEvent = vi.fn();
    recordCapture.mockReturnValueOnce(changed);
    const c = ctx("write", {}, { onEvent });
    recordFileChanges(c);
    expect(onEvent).toHaveBeenCalledWith({ type: "file_changes", sessionId: "sess-1", opId: c.operationId, files: ["/w/a.ts", "/w/b.ts"] });
  });

  it("says nothing when the call changed nothing", () => {
    const onEvent = vi.fn();
    recordCapture.mockReturnValueOnce(null);
    recordFileChanges(ctx("write", {}, { onEvent }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("never throws into the pipeline", () => {
    recordCapture.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => recordFileChanges(ctx("write", {}))).not.toThrow();
  });
});

// 2026-11-08: a downloaded key's private key sat in the rollback store for hours
// after its delete. A credential file (the egress guard's judgment, data-lineage/
// paths.ts isCredentialShapedFile) is never copied aside in plaintext: deleted by
// the name the user gave, nothing is kept; otherwise the copy is sealed.
describe("a credential file is never copied aside in plaintext", () => {
  const FAKE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7fakefakefake
-----END PRIVATE KEY-----`;
  const said = (text: string) => ({ priorMessages: [{ role: "user" as const, content: text }] });

  it("deleted by the name the user gave: final, no copy", async () => {
    const key = join(dir, "agentxos-4c218-9d8a76b91793.json");
    writeFileSync(key, FAKE_KEY);
    await captureRollbackPhase(ctx("delete_file", { path: key }, said("delete agentxos-4c218-9d8a76b91793.json")));
    expect(capturedPaths()).toEqual([{ path: resolveAgentPath(key, "sess-1"), keep: "final" }]);
  });

  it("a shell rm of it by name is final too", async () => {
    const key = join(dir, "service-account.json");
    writeFileSync(key, FAKE_KEY);
    await captureRollbackPhase(ctx("bash", { command: "rm -f service-account.json", _cwd: dir }, said("please delete service-account.json for good")));
    expect(capturedPaths()).toEqual([{ path: join(dir, "service-account.json"), keep: "final" }]);
  });

  it("deleted or changed by the agent on its own: sealed", async () => {
    const key = join(dir, "service-account.json");
    writeFileSync(key, FAKE_KEY);
    await captureRollbackPhase(ctx("delete_file", { path: key }, said("clean up the downloads folder")));
    expect(capturedPaths()).toEqual([{ path: resolveAgentPath(key, "sess-1"), keep: "seal" }]);
    await captureRollbackPhase(ctx("write", { path: key, content: "{}" }, said("delete service-account.json")));
    expect(capturedPaths(), "a write is a change the user asked for, not a wish that nothing remain").toEqual([{ path: resolveAgentPath(key, "sess-1"), keep: "seal" }]);
  });

  it("an ordinary file is a plain copy, as before, named or not", async () => {
    const notes = join(dir, "notes.md");
    writeFileSync(notes, "hello");
    await captureRollbackPhase(ctx("delete_file", { path: notes }, said("delete notes.md")));
    expect(capturedPaths()).toEqual([resolveAgentPath(notes, "sess-1")]);
  });

  it("recordFileChanges names a final delete, so the notice can say it is gone for good", () => {
    const onEvent = vi.fn();
    recordCapture.mockReturnValueOnce(contract([
      { type: "final", original: "/w/key.json", reason: "named" },
      { type: "file-backup", original: "/w/a.ts", backup: "/r/0-a.ts.bak" },
    ]));
    const c = ctx("bash", {}, { onEvent });
    recordFileChanges(c);
    expect(onEvent).toHaveBeenCalledWith({ type: "file_changes", sessionId: "sess-1", opId: c.operationId, files: ["/w/key.json", "/w/a.ts"], final: ["/w/key.json"] });
  });
});

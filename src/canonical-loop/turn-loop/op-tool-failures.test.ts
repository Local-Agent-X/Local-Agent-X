import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureSignature } from "../../tools/failure-signature.js";

// Pinned before any src module loads: nothing here may read the real data dir.
const TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-op-tool-failures-"));
const ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
process.env.LAX_DATA_DIR = TEMP_LAX;

interface Row { messageId: string; opId: string; turnIdx: number; seqInTurn: number; role: string; content: unknown; createdAt: string }
let rows: Row[] = [];

vi.mock("../store.js", () => ({ readOpMessages: () => rows }));

const { readOpToolFailures, renderFailureEvidence } = await import("./op-tool-failures.js");

afterAll(() => {
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  rmSync(TEMP_LAX, { recursive: true, force: true });
});

let seq = 0;
const AT = "2026-11-10T15:00:00.000Z";
function row(role: string, content: unknown, messageId = `m-${seq}`): Row {
  return { messageId, opId: "op_1", turnIdx: 0, seqInTurn: seq++, role, content, createdAt: AT };
}
const user = (text: string, id?: string) => row("user", { text }, id);
const calls = (...toolCalls: Array<{ id: string; name: string; arguments: string }>) => row("assistant", { text: "", toolCalls });
const result = (toolCallId: string, text: string, status: string, block?: { layer: string; deferredTo?: string }, id?: string) =>
  row("tool_result", { toolCallId, result: text, status, ...(block ? { block } : {}) }, id);

beforeEach(() => { rows = []; seq = 0; });

describe("readOpToolFailures", () => {
  it("identifies each failed call the way the live record does", () => {
    rows = [
      user("run the report"),
      calls({ id: "c1", name: "bash", arguments: '{"command":"python3 report.py"}' }),
      result("c1", "python3: command not found\nexit 127", "error"),
      calls({ id: "c2", name: "office", arguments: '{"action":"read","path":"C:\\\\x.xlsx"}' }),
      result("c2", "outside the workspace", "blocked", { layer: "security" }),
    ];
    expect(readOpToolFailures("op_1")).toEqual([
      {
        toolCallId: "c1", tool: "bash", status: "error", reason: "python3: command not found", at: Date.parse(AT),
        signature: failureSignature({ tool: "bash", status: "error", reason: "python3: command not found" }),
      },
      {
        toolCallId: "c2", tool: "office", action: "read", status: "blocked", layer: "security",
        reason: "outside the workspace", at: Date.parse(AT),
        signature: failureSignature({ tool: "office", action: "read", status: "blocked", layer: "security", reason: "outside the workspace" }),
      },
    ]);
  });

  it("pairs a result with its call by id, not by position", () => {
    rows = [
      user("do both"),
      calls({ id: "c1", name: "read", arguments: "{}" }, { id: "c2", name: "edit", arguments: "{}" }),
      // Results arrive in the other order.
      result("c2", "old_string found 2 times", "error"),
      result("c1", "file contents", "ok"),
    ];
    expect(readOpToolFailures("op_1").map((f) => [f.tool, f.toolCallId])).toEqual([["edit", "c2"]]);
  });

  it("leaves out what worked, what the user declined or stopped, and what waits on a person", () => {
    rows = [
      user("go"),
      calls(
        { id: "c1", name: "read", arguments: "{}" }, { id: "c2", name: "bash", arguments: "{}" },
        { id: "c3", name: "bash", arguments: "{}" }, { id: "c4", name: "bash", arguments: "{}" },
      ),
      result("c1", "ok", "ok"),
      result("c2", "the user said no", "declined"),
      result("c3", "stopped", "cancelled"),
      result("c4", "needs approval", "blocked", { layer: "approval", deferredTo: "inbox_1" }),
    ];
    expect(readOpToolFailures("op_1")).toEqual([]);
  });

  it("does not count a failure the op only carries as the chat's earlier history", () => {
    rows = [
      user("first message", "hist-0"),
      { ...calls({ id: "old", name: "bash", arguments: "{}" }), messageId: "hist-1" },
      result("old", "python3: command not found", "error", undefined, "hist-2"),
      user("second message"),
      calls({ id: "new", name: "bash", arguments: "{}" }),
      result("new", "python3: command not found", "error"),
    ];
    expect(readOpToolFailures("op_1").map((f) => f.toolCallId)).toEqual(["new"]);
  });
});

describe("renderFailureEvidence", () => {
  it("shows the ask, the failed call, and what the run did until the same work succeeded", () => {
    rows = [
      user("run the report"),
      calls({ id: "c1", name: "bash", arguments: '{"command":"python3 report.py"}' }),
      result("c1", "python3: command not found", "error"),
      calls({ id: "c2", name: "bash", arguments: '{"command":"python report.py"}' }),
      result("c2", "report written", "ok"),
      calls({ id: "c3", name: "read", arguments: '{"path":"report.txt"}' }),
      result("c3", "the report", "ok"),
    ];
    const evidence = renderFailureEvidence("op_1", "c1");
    expect(evidence?.recovered).toBe(true);
    expect(evidence?.text).toBe([
      "[USER] run the report",
      '[FAILED CALL] bash {"command":"python3 report.py"}',
      "[RESULT bash, error] python3: command not found",
      '[THEN] bash {"command":"python report.py"}',
      "[RESULT bash, ok] report written",
    ].join("\n"));
  });

  it("says the run never recovered when the same tool never worked again", () => {
    rows = [
      user("open the sheet"),
      calls({ id: "c1", name: "office", arguments: '{"action":"read"}' }),
      result("c1", "outside the workspace", "blocked", { layer: "security" }),
      // A different action of the same tool working is not the same work.
      calls({ id: "c2", name: "office", arguments: '{"action":"list"}' }),
      result("c2", "3 sheets", "ok"),
    ];
    const evidence = renderFailureEvidence("op_1", "c1");
    expect(evidence?.recovered).toBe(false);
    expect(evidence?.text).toContain("[RESULT office, blocked, refused by security] outside the workspace");
    expect(evidence?.text).toContain('[THEN] office {"action":"list"}');
  });

  it("clips a long result and never lets a secret through the clip", () => {
    const secret = "sk-ant-api03-" + "A".repeat(90);
    rows = [
      user("call the api"),
      calls({ id: "c1", name: "http_request", arguments: "{}" }),
      result("c1", `401 for ${secret} ` + "x".repeat(2000), "error"),
    ];
    const evidence = renderFailureEvidence("op_1", "c1");
    expect(evidence?.text).not.toContain(secret);
    expect(evidence?.text).not.toContain("A".repeat(40));
    expect(evidence!.text.length).toBeLessThan(1200);
  });

  it("is null for a call the run does not hold", () => {
    rows = [user("hi")];
    expect(renderFailureEvidence("op_1", "missing")).toBeNull();
  });
});

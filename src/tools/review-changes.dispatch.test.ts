// review_changes through the real dispatch pipeline (executeToolCalls): the
// session and request it reviews come from the trusted stamps its policy row
// declares (reads: session, operation), never from the model's arguments, and it
// reads the real rollback store the file tools capture into.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setAriRequired } from "../ari-kernel/state.js";
import { captureBeforeCall, recordCapture } from "../autonomy/rollback.js";
import { dispatchOne } from "../tool-execution/dispatch-one.test-helper.js";
import { reviewChangesTool } from "./review-changes.js";

// Inside the home directory: the paths a write (and this review's read gate) may reach.
const dir = mkdtempSync(join(homedir(), "lax-review-dispatch-"));
beforeAll(() => setAriRequired(false));
afterAll(() => { setAriRequired(true); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const uniq = (s: string): string => `${s}-${Date.now().toString(36)}-${n++}`;

/** What a file tool does: capture the file aside, write it, record the capture. */
function agentWrite(sessionId: string, opId: string, path: string, body: string): void {
  const pending = captureBeforeCall({ toolCallId: uniq("tc"), tool: "write", sessionId, opId }, [path]);
  writeFileSync(path, body);
  recordCapture(pending);
}

function review(sessionId: string, operationId: string, args: Record<string, unknown> = {}) {
  return dispatchOne(
    { id: uniq("call"), name: "review_changes", args },
    { toolMap: new Map([["review_changes", reviewChangesTool]]), security: undefined as never, sessionId, operationId, callContext: "local" },
  );
}

describe("review_changes, dispatched", () => {
  it("reviews the stamped session's request: each file against its bytes from before it", async () => {
    const session = uniq("s"), op = uniq("op");
    const file = join(dir, "app.ts");
    writeFileSync(file, "export const port = 3000;\n");
    agentWrite(session, op, file, "export const port = 3001;\n");
    agentWrite(session, op, file, "export const port = 8080;\nconsole.log(port);\n");

    const r = await review(session, op);
    expect(r.isError).toBeFalsy();
    const text = String(r.content);
    expect(text).toContain("1 file changed for this request");
    expect(text).toContain(`${file}: +2 -1`);
    expect(text).toContain("-export const port = 3000;"); // against the bytes from before the request, not the middle write
    expect(text).toContain("+console.log(port);");
  });

  it("a session id the model passes is dropped: it cannot review another chat's changes", async () => {
    const mine = uniq("s"), theirs = uniq("s"), myOp = uniq("op"), theirOp = uniq("op");
    const theirFile = join(dir, "theirs.ts");
    writeFileSync(theirFile, "a\n");
    agentWrite(theirs, theirOp, theirFile, "b\n");

    const r = await review(mine, myOp, { _sessionId: theirs, _operationId: theirOp });
    expect(String(r.content)).toContain("No file changes from this request");
    expect(String(r.content)).not.toContain("theirs.ts");
  });
});

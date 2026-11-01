import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { captureRollback, loadRestoredIds } from "./rollback.js";
import { planRewind, rewindToBeforeOp } from "./rollback-rewind.js";

// The rewind's targets must be paths the file-access layer lets a write
// reach, which is inside the (test's) home directory.
const work = (): string => mkdtempSync(join(homedir(), "lax-rewind-"));
let n = 0;
const uniq = (s: string): string => `${s}-${Date.now().toString(36)}-${n++}`;

/** Capture, then do what the tool would have done. */
function agentWrite(session: string, op: string, path: string, body: string): string {
  const toolCallId = uniq("tc");
  captureRollback({ toolCallId, tool: "write", sessionId: session, opId: op }, [path]);
  writeFileSync(path, body);
  return toolCallId;
}

describe("rewindToBeforeOp", () => {
  it("puts every file the request changed back, and removes the files it created", async () => {
    const dir = work(), session = uniq("s"), op = uniq("op");
    const edited = join(dir, "app.ts"), made = join(dir, "new.ts");
    writeFileSync(edited, "before");
    agentWrite(session, op, edited, "after 1");
    agentWrite(session, op, edited, "after 2");
    agentWrite(session, op, made, "fresh");

    const r = await rewindToBeforeOp(session, op);
    expect(r).toEqual({ ok: true, restored: [edited], removed: [made], failed: [] });
    expect(readFileSync(edited, "utf-8")).toBe("before");
    expect(existsSync(made)).toBe(false);
  });

  it("rewinds a point in time: later requests' changes go too, and the plan counts them first", async () => {
    const dir = work(), session = uniq("s"), first = uniq("op"), later = uniq("op");
    const a = join(dir, "a.ts"), b = join(dir, "b.ts");
    writeFileSync(a, "a0"); writeFileSync(b, "b0");
    agentWrite(session, first, a, "a1");
    agentWrite(session, later, a, "a2");
    agentWrite(session, later, b, "b1");

    expect(planRewind(session, first)).toEqual({ files: [a, b], laterRequests: 1 });
    await rewindToBeforeOp(session, first);
    expect(readFileSync(a, "utf-8")).toBe("a0");
    expect(readFileSync(b, "utf-8")).toBe("b0");
  });

  it("leaves earlier requests and other sessions alone", async () => {
    const dir = work(), session = uniq("s"), other = uniq("s"), earlier = uniq("op"), op = uniq("op");
    const mine = join(dir, "mine.ts"), theirs = join(dir, "theirs.ts");
    writeFileSync(mine, "m0"); writeFileSync(theirs, "t0");
    agentWrite(session, earlier, mine, "m1");
    agentWrite(session, op, mine, "m2");
    agentWrite(other, uniq("op"), theirs, "t1");

    await rewindToBeforeOp(session, op);
    expect(readFileSync(mine, "utf-8")).toBe("m1");
    expect(readFileSync(theirs, "utf-8")).toBe("t1");
  });

  it("spends the range, so a second Undo of the same request finds nothing", async () => {
    const dir = work(), session = uniq("s"), op = uniq("op");
    const f = join(dir, "f.ts");
    writeFileSync(f, "0");
    const id = agentWrite(session, op, f, "1");

    expect((await rewindToBeforeOp(session, op)).ok).toBe(true);
    expect(loadRestoredIds().has(id)).toBe(true);
    expect((await rewindToBeforeOp(session, op)).ok).toBe(false);
    expect(planRewind(session, op)).toBeNull();
  });

  it("keeps a call restorable when its undo is refused", async () => {
    const session = uniq("s"), op = uniq("op");
    const outside = join(homedir(), ".ssh", uniq("authorized_keys"));
    const id = uniq("tc");
    captureRollback({ toolCallId: id, tool: "write", sessionId: session, opId: op }, [outside]);

    const r = await rewindToBeforeOp(session, op);
    expect(r.ok && r.failed.map((f) => f.path)).toEqual([outside]);
    expect(loadRestoredIds().has(id)).toBe(false);
  });
});

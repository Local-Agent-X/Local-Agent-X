// What a delivered sensitive read leaves on its row: the (source, target)
// pairs it committed, as `metadata.taint_sources`, so recovery can taint the
// session again after a restart (canonical-loop/recovery-taint.ts). A read the
// stub replaced committed nothing and persists nothing.
import { afterEach, describe, expect, it } from "vitest";
import { applyResultTaintPolicy, setPreExecuteTaintFloor } from "./sensitive-read-taint.js";
import { clearSessionTaint, getTaintSummary } from "../data-lineage/index.js";
import type { ToolResult } from "../types.js";

let seq = 0;
const sessions: string[] = [];
function session(): string {
  const id = `persisted-taint-${process.pid}-${seq++}`;
  sessions.push(id);
  return id;
}
afterEach(() => { while (sessions.length > 0) clearSessionTaint(sessions.pop()!); });

type Persisted = Array<{ source: string; target: string }>;

describe("a delivered sensitive read persists the taint it committed", () => {
  it("an errored read of a key file is delivered, taints, and names the pair once on its row", () => {
    const sid = session();
    const args = { path: "/home/u/.ssh/id_rsa" };
    const floor = setPreExecuteTaintFloor("read", args, sid);
    expect(floor.pairs).toHaveLength(1);
    const row: ToolResult = { content: "-----BEGIN OPENSSH PRIVATE KEY-----\n(truncated)", isError: true };
    const out = applyResultTaintPolicy("read", args, sid, row, floor)!;
    expect(out.isError).toBe(true);
    const sources = out.metadata?.taint_sources as Persisted;
    expect(sources).toHaveLength(1);
    expect(sources[0].source).toBe("sensitive_file");
    expect(sources[0].target).toMatch(/id_rsa$/);
    expect(sources[0].target).toBe(floor.pairs[0].target);
    expect(getTaintSummary(sid).count).toBeGreaterThan(0);
  });

  it("a read the stub replaced persists nothing: nothing was delivered, nothing is tainted", () => {
    const sid = session();
    const args = { path: "/home/u/.ssh/id_rsa" };
    const floor = setPreExecuteTaintFloor("read", args, sid);
    const out = applyResultTaintPolicy("read", args, sid, { content: "-----BEGIN OPENSSH PRIVATE KEY-----" }, floor)!;
    expect(out.status).toBe("blocked");
    expect(out.metadata?.taint_sources).toBeUndefined();
    expect(getTaintSummary(sid).count).toBe(0);
  });

  it("a command that named a secrets file and errored keeps its floor pairs on the row", () => {
    const sid = session();
    const args = { command: "cat ~/.ssh/id_rsa ~/.aws/credentials" };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    expect(floor.pairs.length).toBeGreaterThan(0);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "cat: ~/.aws/credentials: No such file", isError: true, status: "error", metadata: { exit_code: 1 } }, floor)!;
    const sources = out.metadata?.taint_sources as Persisted;
    expect(sources.map((s) => s.target)).toEqual(floor.pairs.map((p) => p.target));
    expect(out.metadata?.exit_code).toBe(1);
  });

  it("a plain read of an ordinary file persists no taint", () => {
    const sid = session();
    const args = { path: "/home/u/notes.txt" };
    const floor = setPreExecuteTaintFloor("read", args, sid);
    const out = applyResultTaintPolicy("read", args, sid, { content: "groceries" }, floor)!;
    expect(out.metadata).toBeUndefined();
  });
});

// What a delivered sensitive read leaves on its row: the (source, target)
// pairs it committed, as `metadata.taint_sources`, so recovery can taint the
// session again after a restart (canonical-loop/recovery-taint.ts). A read the
// stub replaced committed nothing and persists nothing.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyResultTaintPolicy, setPreExecuteTaintFloor } from "./sensitive-read-taint.js";
import { clearSessionTaint, getTaintSummary } from "../data-lineage/index.js";
import type { ToolResult } from "../types.js";

let seq = 0;
const sessions: string[] = [];
const dirs: string[] = [];
function session(): string {
  const id = `persisted-taint-${process.pid}-${seq++}`;
  sessions.push(id);
  return id;
}
/** A real secrets file: an errored delivery keeps a taint only for a file whose bytes it echoed. */
function keyFile(name: string, body = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-persisted-key-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body, "utf-8");
  return file.replace(/\\/g, "/");
}
afterEach(() => {
  while (sessions.length > 0) clearSessionTaint(sessions.pop()!);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Persisted = Array<{ source: string; target: string }>;

describe("a delivered sensitive read persists the taint it committed", () => {
  it("an errored read of a key file is delivered, taints, and names the pair once on its row", () => {
    const sid = session();
    const args = { path: keyFile("id_rsa") };
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

  // The row keeps the pair of the file the error output echoed, and not the
  // one it only named: a failed `cat` of a file carries none of its bytes.
  it("a command that named two secrets files and errored keeps on the row the pair whose bytes it echoed", () => {
    const sid = session();
    const key = keyFile("id_rsa");
    const creds = keyFile(".netrc", "machine api.example.com login u password hunter2hunter2\n");
    const args = { command: `cat ${key} ${creds}` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    expect(floor.pairs.length).toBe(2);
    const out = applyResultTaintPolicy("bash", args, sid, { content: `-----BEGIN OPENSSH PRIVATE KEY-----\ncat: ${creds}: Permission denied`, isError: true, status: "error", metadata: { exit_code: 1 } }, floor)!;
    const sources = out.metadata?.taint_sources as Persisted;
    expect(sources.map((s) => s.target)).toEqual([floor.pairs[0].target]);
    expect(sources[0].target).toMatch(/id_rsa$/);
    expect(out.metadata?.exit_code).toBe(1);
  });

  it("a command that named a secrets file and errored without echoing it persists no taint", () => {
    const sid = session();
    const args = { command: `cat ${keyFile(".env")} | sed 's/=.*/=<set>/'; ls apps/mobile/.env` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    expect(floor.pairs.length).toBe(1);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "KEY=<set>\nls: cannot access 'apps/mobile/.env': No such file", isError: true, status: "error", metadata: { exit_code: 2 } }, floor)!;
    expect(out.metadata?.taint_sources).toBeUndefined();
    expect(getTaintSummary(sid).count).toBe(0);
  });

  it("a plain read of an ordinary file persists no taint", () => {
    const sid = session();
    const args = { path: "/home/u/notes.txt" };
    const floor = setPreExecuteTaintFloor("read", args, sid);
    const out = applyResultTaintPolicy("read", args, sid, { content: "groceries" }, floor)!;
    expect(out.metadata).toBeUndefined();
  });
});

// Peter, 2026-11-01: a .env looked at through the shell is treated like the
// read tool's keys-only view. The harness masks every value itself; the
// output is delivered only when, masked, it carries none of the file's bytes.
describe("a shell read of a dotenv file", () => {
  const env = () => keyFile(".env", "OPENAI_API_KEY=sk-live-0123456789abcdef\nDB_PASSWORD=correct-horse-battery\n# a comment\n");

  it("delivers the key names with every value masked, and taints nothing", () => {
    const sid = session();
    const args = { command: `cat ${env()} | sed 's/=.*/=<set>/'` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    expect(floor.pairs.length).toBe(1);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "OPENAI_API_KEY=<set>\nDB_PASSWORD=<set>\n# a comment" }, floor)!;
    expect(out.status).not.toBe("blocked");
    expect(out.content).toContain("OPENAI_API_KEY=");
    expect(out.metadata?.keys_only).toBe(true);
    expect(getTaintSummary(sid).count).toBe(0);
  });

  it("masks the values itself when the command printed them", () => {
    const sid = session();
    const args = { command: `cat ${env()}` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "OPENAI_API_KEY=sk-live-0123456789abcdef\nDB_PASSWORD=correct-horse-battery" }, floor)!;
    expect(String(out.content)).not.toContain("sk-live-0123456789abcdef");
    expect(String(out.content)).not.toContain("correct-horse-battery");
    expect(getTaintSummary(sid).count).toBe(0);
  });

  it("withholds output that prints a value bare", () => {
    const sid = session();
    const args = { command: `cut -d= -f2 ${env()}` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "sk-live-0123456789abcdef\ncorrect-horse-battery" }, floor)!;
    expect(out.status).toBe("blocked");
    expect(String(out.content)).not.toContain("sk-live");
  });

  it("withholds a command that also reads a non-dotenv secrets file", () => {
    const sid = session();
    const args = { command: `cat ${env()} ${keyFile("id_rsa")}` };
    const floor = setPreExecuteTaintFloor("bash", args, sid);
    const out = applyResultTaintPolicy("bash", args, sid, { content: "OPENAI_API_KEY=x\n-----BEGIN OPENSSH PRIVATE KEY-----" }, floor)!;
    expect(out.status).toBe("blocked");
  });
});

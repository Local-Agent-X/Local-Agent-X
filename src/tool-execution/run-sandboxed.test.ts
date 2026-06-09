// Integration coverage for the stale-read guard wired into the execute phase.
// The freshness *core* is unit-tested in tools/read-state.test.ts; this drives
// the real runSandboxedPhase with the real read/edit tools to prove the guard
// (a) blocks an edit to a file the session hasn't read, (b) lets it through
// after a read, (c) re-blocks once the file changes on disk, and (d) never
// writes when it blocks.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSandboxedPhase } from "./run-sandboxed.js";
import type { ToolCallContext } from "./context.js";
import { readTool, editTool } from "../tools/file-tools.js";
import type { ToolDefinition } from "../types.js";

const dirs = new Set<string>();
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  dirs.clear();
});

let seq = 0;
function freshSession(): string { return `rs-test-${seq++}`; }

function tmpFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lax-guard-"));
  dirs.add(dir);
  const file = join(dir, "f.txt");
  writeFileSync(file, body, "utf-8");
  return file;
}

function ctxFor(tool: ToolDefinition, args: Record<string, unknown>, sessionId: string): ToolCallContext {
  return {
    tc: { id: "tc1", name: tool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[tool.name, tool]]),
    tool,
    args,
    sessionId,
    callContext: "local",
    riskLevel: "low",
    approvalContext: "",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;
}

async function run(tool: ToolDefinition, args: Record<string, unknown>, sessionId: string) {
  const ctx = ctxFor(tool, args, sessionId);
  await runSandboxedPhase(ctx);
  return ctx.result!;
}

describe("stale-read guard (run-sandboxed integration)", () => {
  it("blocks an edit to a file the session has not read", async () => {
    const file = tmpFile("hello world\n");
    const res = await run(editTool, { path: file, old_string: "hello", new_string: "HELLO" }, freshSession());
    expect(res.status).toBe("blocked");
    expect(res.content).toMatch(/hasn't read it/);
    expect(readFileSync(file, "utf-8")).toBe("hello world\n"); // untouched
  });

  it("allows the edit once the session has read the file", async () => {
    const file = tmpFile("hello world\n");
    const s = freshSession();
    await run(readTool, { path: file }, s);
    const res = await run(editTool, { path: file, old_string: "hello", new_string: "HELLO" }, s);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("HELLO world\n");
  });

  it("re-blocks after the file changes on disk since it was read", async () => {
    const file = tmpFile("hello world\n");
    const s = freshSession();
    await run(readTool, { path: file }, s);
    writeFileSync(file, "changed underneath\n", "utf-8"); // external change
    const res = await run(editTool, { path: file, old_string: "changed", new_string: "X" }, s);
    expect(res.status).toBe("blocked");
    expect(res.content).toMatch(/changed on disk/);
    expect(readFileSync(file, "utf-8")).toBe("changed underneath\n"); // untouched
  });
});

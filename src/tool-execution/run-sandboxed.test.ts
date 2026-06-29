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
import { checkEgressTaint, clearSessionTaint } from "../data-lineage-taint.js";
import { detectSecretsInOutput } from "../data-lineage-paths.js";

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

// A fake `bash` whose result we fully control — runSandboxedPhase keys the taint
// branch on tc.name === "bash" and reads ctx.result.{content,isError}.
function fakeBash(content: string, isError: boolean): ToolDefinition {
  return {
    name: "bash",
    description: "fake bash for taint tests",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() { return { content, isError }; },
  } as unknown as ToolDefinition;
}

describe("bash-output taint respects isError (the ARI over-block fix)", () => {
  // Secret-shaped output (canonical AWS example key). The first test pins that
  // the scanner really matches it, so the two taint assertions are meaningful.
  const SECRET = "config dump: AKIAIOSFODNN7EXAMPLE region=us-east-1";

  it("sanity: the sample is detected as secret-shaped", () => {
    expect(detectSecretsInOutput(SECRET).matched).toBe(true);
  });

  it("a SUCCESSFUL bash with secret-shaped output still taints the session", async () => {
    const s = freshSession();
    clearSessionTaint(s);
    await run(fakeBash(SECRET, false), { command: "cat config" }, s);
    expect(checkEgressTaint(s).blocked).toBe(true);   // real read → egress blocked
    clearSessionTaint(s);
  });

  it("a FAILED bash with secret-shaped error output does NOT taint", async () => {
    const s = freshSession();
    clearSessionTaint(s);
    await run(fakeBash(SECRET, true), { command: "cat config" }, s);
    // The bug: a benign nonzero-exit command whose stderr happened to contain a
    // secret-shaped token tainted the session and locked the run out of editing.
    expect(checkEgressTaint(s).blocked).toBe(false);
    clearSessionTaint(s);
  });
});

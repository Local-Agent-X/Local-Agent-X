// process_* tool tests. These spawn REAL short-lived node processes (no bash,
// no sleep, no port-binding — all flaky in CI) and prove the two bugs this
// change fixes: (a) detached spawn lets process_kill actually terminate the
// child, and (b) process_restart replaces a tracked session with a new one.

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  processStartTool,
  processStatusTool,
  processKillTool,
  processRestartTool,
  runningSessionsForPath,
} from "./process-tools.js";
import type { ToolResult } from "../types.js";

// A node one-liner that stays alive until killed.
const FOREVER = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;

// Track every session we start so afterEach can reap leaks even on failure.
const spawned = new Set<string>();

function sessionIdOf(r: ToolResult): string {
  return r.session_id ?? "";
}

async function startForever(): Promise<string> {
  const r = await processStartTool.execute({ command: FOREVER });
  const id = sessionIdOf(r);
  if (id) spawned.add(id);
  return id;
}

async function isRunning(sessionId: string): Promise<boolean> {
  const r = await processStatusTool.execute({ session_id: sessionId });
  return r.metadata?.running === true;
}

async function pollRunning(sessionId: string, want: boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isRunning(sessionId)) === want) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return (await isRunning(sessionId)) === want;
}

afterEach(async () => {
  for (const id of spawned) {
    try { await processKillTool.execute({ session_id: id }); } catch { /* best effort */ }
  }
  spawned.clear();
});

describe("process_kill (detached tree-kill regression)", () => {
  it("actually terminates a long-running child", async () => {
    const id = await startForever();
    expect(id).toBeTruthy();
    expect(await pollRunning(id, true)).toBe(true);

    const killRes = await processKillTool.execute({ session_id: id });
    expect(killRes.isError).toBeFalsy();

    expect(await pollRunning(id, false)).toBe(true);
  }, 20_000);

  it("kill success carries a port/restart reminder", async () => {
    const id = await startForever();
    expect(await pollRunning(id, true)).toBe(true);

    const killRes = await processKillTool.execute({ session_id: id });
    expect(killRes.isError).toBeFalsy();
    // The orphan-port reminder rides on metadata.recovery so the model knows a
    // freed-looking port may still be held; it should reach for process_restart.
    const recovery = String(killRes.metadata?.recovery ?? "");
    expect(recovery).toMatch(/port/i);
    expect(recovery).toMatch(/process_restart/);
  }, 20_000);
});

describe("runningSessionsForPath", () => {
  it("matches a live session whose cwd is an ancestor of the file", async () => {
    const cwd = tmpdir();
    const r = await processStartTool.execute({ command: FOREVER, cwd });
    const id = sessionIdOf(r);
    spawned.add(id);
    expect(await pollRunning(id, true)).toBe(true);

    const hits = runningSessionsForPath(join(cwd, "nested", "served.js"));
    expect(hits.some(h => h.sessionId === id)).toBe(true);
  }, 20_000);

  it("does not match after the session exits", async () => {
    const cwd = tmpdir();
    const r = await processStartTool.execute({ command: FOREVER, cwd });
    const id = sessionIdOf(r);
    spawned.add(id);
    expect(await pollRunning(id, true)).toBe(true);

    await processKillTool.execute({ session_id: id });
    expect(await pollRunning(id, false)).toBe(true);

    const hits = runningSessionsForPath(join(cwd, "served.js"));
    expect(hits.some(h => h.sessionId === id)).toBe(false);
  }, 20_000);
});

describe("process_restart", () => {
  it("replaces a tracked session with a new running one", async () => {
    const oldId = await startForever();
    expect(await pollRunning(oldId, true)).toBe(true);

    const res = await processRestartTool.execute({ session_id: oldId });
    expect(res.isError).toBeFalsy();
    const newId = sessionIdOf(res);
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(oldId);
    spawned.add(newId);

    // Old one must be gone, new one must be live.
    expect(await pollRunning(oldId, false)).toBe(true);
    expect(await pollRunning(newId, true)).toBe(true);

    // Cleanup of the new session is handled by afterEach.
  }, 25_000);

  it("requires a command or session_id", async () => {
    const res = await processRestartTool.execute({});
    expect(res.isError).toBe(true);
  });

  it("errors on an unknown session_id", async () => {
    const res = await processRestartTool.execute({ session_id: "px-deadbeef" });
    expect(res.isError).toBe(true);
  });
});

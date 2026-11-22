// "Send now": a message typed while the agent waits on a long shell command
// sat unread until the command ended, ten minutes behind a polling loop
// (2026-11-22). The command moves to the background and keeps running; the
// bash call returns at once so the agent's next step reads the message.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "./shell-tool.js";
import { holdForSendNow, sendNow } from "./shell-handoff.js";
import { SESSIONS, killSession } from "./process-session.js";
import { statusOf } from "./result-helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const s of SESSIONS.values()) if (s.command.includes("lax-send-now-test")) { killSession(s); SESSIONS.delete(s.sessionId); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Prints "first", then "second" after `gapMs`, then exits. The marker names
// this test's sessions for cleanup.
const twoLines = (gapMs: number) =>
  `node -e "console.log('first'); setTimeout(() => console.log('second'), ${gapMs})" # lax-send-now-test`;

function runBash(chat: string, command: string, timeout = 60_000) {
  const cwd = mkdtempSync(join(tmpdir(), "lax-send-now-"));
  dirs.push(cwd);
  return bashTool.execute({ command, timeout, _cwd: cwd, _sessionId: chat });
}

async function whenPrinted(chat: string, text: string): Promise<void> {
  // The run registers its hold before the child is up; wait for its output.
  for (let i = 0; i < 200; i++) {
    const s = [...SESSIONS.values()].find((x) => x.command.includes("lax-send-now-test"));
    if (s?.stdout.includes(text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${chat}: never printed ${text}`);
}

describe("Send now", () => {
  it("returns the bash call at once and the command keeps running in a process session", async () => {
    const call = runBash("chat-send-now-1", twoLines(1500));
    await new Promise((r) => setTimeout(r, 700));
    expect(sendNow("chat-send-now-1")).toBe(1);

    const result = await call;
    expect(statusOf(result)).toBe("running");
    expect(result.metadata?.moved_to_background).toBe(true);
    const id = (result as { session_id?: string }).session_id!;
    expect(result.content).toContain(`process_status({"session_id": "${id}"})`);
    expect(result.content).toContain("first");

    const session = SESSIONS.get(id)!;
    expect(session.exitedAt).toBeNull();
    await session.exited;
    expect(session.exitCode).toBe(0);
    expect(session.stdout).toContain("second");
    await whenPrinted("chat-send-now-1", "second");
  }, 30_000);

  it("keeps the command's own timeout once it is in the background", async () => {
    const call = runBash("chat-send-now-2", twoLines(60_000), 2_500);
    await new Promise((r) => setTimeout(r, 700));
    sendNow("chat-send-now-2");
    const session = SESSIONS.get((await call as { session_id?: string }).session_id!)!;
    await session.exited;
    expect(Date.now() - session.startedAt).toBeLessThan(20_000);
    expect(session.stdout).not.toContain("second");
  }, 30_000);

  it("moves nothing for a chat whose agent is not waiting on a command, nor once the command ended", async () => {
    expect(sendNow("chat-send-now-idle")).toBe(0);
    const done = await runBash("chat-send-now-3", `node -e "console.log('quick')" # lax-send-now-test`);
    expect(statusOf(done)).toBe("ok");
    expect(sendNow("chat-send-now-3")).toBe(0);
  }, 30_000);

  it("moves only the chat that asked", () => {
    const mine = holdForSendNow("chat-a");
    const theirs = holdForSendNow("chat-b");
    expect(sendNow("chat-a")).toBe(1);
    expect(mine.signal?.aborted).toBe(true);
    expect(theirs.signal?.aborted).toBe(false);
    theirs.release();
    expect(sendNow("chat-b")).toBe(0);
    mine.release();
  });
});

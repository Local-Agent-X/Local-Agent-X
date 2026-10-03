// process_* tool tests. These spawn REAL short-lived node processes (no bash,
// no sleep, no port-binding — all flaky in CI) and prove the two bugs this
// change fixes: (a) detached spawn lets process_kill actually terminate the
// child, and (b) process_restart replaces a tracked session with a new one.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The Windows cage: no helper (so every suite here spawns on the host, on any
// machine), a helper whose fence proof is still running when any wait for it
// ends, or a proven one whose sandbox user is still being granted the
// workspace. Every export that would reach the real srt-win helper is
// modelled, so no test here runs the helper on a machine that has the cage
// installed; a caged command is a node child that stays up.
const cage = vi.hoisted(() => ({
  helper: null as string | null,
  proven: false,
  granted: false,
  grantsDone: Promise.resolve(),
  grantFailure: null as string | null,
  wrapped: 0,
}));
vi.mock("../sandbox/win-cage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/win-cage.js")>()),
  resolveWinCageHelper: () => cage.helper,
  winCageStatus: () => ({ helper: cage.helper, installed: cage.helper !== null, detail: "modelled" }),
  winCageEnforcesSync: () => cage.proven,
  winCageEnforces: async () => cage.proven,
  winCageProbePending: () => cage.helper !== null && !cage.proven,
  winCageProofView: () => ({ proofPending: cage.helper !== null && !cage.proven }),
  winCageUnusableReason: () => (cage.proven ? null : cage.helper === null ? "the cage helper is not present (modelled)" : "the fence proof is still running"),
  wrapForWinCage: () => {
    if (!cage.proven) throw new Error("the cage is not proven here, so nothing is wrapped");
    cage.wrapped++;
    return { cmd: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] };
  },
}));
vi.mock("../sandbox/win-cage-grants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/win-cage-grants.js")>();
  return {
    ...actual,
    ensureWinCageGrants: async () => {
      if (cage.grantFailure) throw new actual.WinCageGrantFailedError(cage.grantFailure);
      await cage.grantsDone;
      cage.granted = true;
    },
    ensureWinCageGrantsSync: () => {
      if (cage.grantFailure) throw new actual.WinCageGrantFailedError(cage.grantFailure);
      if (cage.proven && !cage.granted) throw new actual.WinCageGrantPendingError();
    },
  };
});
// A guarded start asks for the egress proxy's route; these tests start no proxy.
vi.mock("./shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));

import {
  processStartTool,
  processStatusTool,
  processKillTool,
  processRestartTool,
  runningSessionsForPath,
} from "./process-tools.js";
import { SESSIONS, startSession } from "./process-session.js";
import type { ToolResult } from "../types.js";

// A node one-liner that stays alive until killed.
const nodeExecutable = process.platform === "win32"
  ? process.execPath.replace(/\\/g, "/")
  : process.execPath;
const FOREVER = `"${nodeExecutable}" -e "setInterval(()=>{},1000)"`;

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

describe("startSession while the Windows cage is still proving its fence", () => {
  const realPlatform = process.platform;
  const prevMode = process.env.LAX_SANDBOX;
  beforeEach(() => {
    process.env.LAX_SANDBOX = "guarded";
    Object.defineProperty(process, "platform", { value: "win32" });
    cage.helper = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    cage.helper = null;
    if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
  });

  // Dev servers start through here synchronously and cannot wait for the
  // proof; the refusal must name the wait, not read as a broken command.
  it("refuses with a retryable message and starts nothing", () => {
    const before = SESSIONS.size;
    const r = startSession(FOREVER);
    expect(r).toEqual({ error: expect.stringMatching(/^The Windows shell cage is still being verified; try again in a few seconds\./) });
    expect(SESSIONS.size).toBe(before);
  });
});

describe("process_restart while the Windows cage is still proving its fence", () => {
  const realPlatform = process.platform;
  const prevMode = process.env.LAX_SANDBOX;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    cage.helper = null;
    if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
  });

  // Refusing only at the new start would leave the old process dead and
  // nothing in its place.
  it("refuses before stopping the session it would replace", async () => {
    const oldId = await startForever();
    expect(await pollRunning(oldId, true)).toBe(true);

    process.env.LAX_SANDBOX = "guarded";
    Object.defineProperty(process, "platform", { value: "win32" });
    cage.helper = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
    const res = await processRestartTool.execute({ session_id: oldId });
    Object.defineProperty(process, "platform", { value: realPlatform });

    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/still being verified; try again in a few seconds\. Nothing was stopped or started\.$/);
    expect(await isRunning(oldId)).toBe(true);
  }, 20_000);
});

// The proof has landed, and the server is still granting the sandbox user the
// workspace in the background. startSession cannot wait for that and refuses;
// the tools can, so they wait instead of passing the refusal on.
describe("process_* on a proven Windows cage whose grants are still being made", () => {
  const realPlatform = process.platform;
  const prevMode = process.env.LAX_SANDBOX;
  const prevDataDir = process.env.LAX_DATA_DIR;
  let dataDir: string;
  let release!: () => void;
  const cageOn = (): void => {
    process.env.LAX_SANDBOX = "guarded";
    Object.defineProperty(process, "platform", { value: "win32" });
    cage.helper = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
    cage.proven = true;
  };
  const cageOff = (): void => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    cage.helper = null;
    cage.proven = false;
  };
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-process-grants-"));
    process.env.LAX_DATA_DIR = dataDir;
    cage.granted = false;
    cage.grantFailure = null;
    cage.wrapped = 0;
    cage.grantsDone = new Promise<void>((r) => { release = r; });
  });
  afterEach(() => {
    cageOff();
    release();
    if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
    if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("process_start waits for them, then starts the command in the cage", async () => {
    cageOn();
    const before = SESSIONS.size;
    const pending = processStartTool.execute({ command: FOREVER });
    await new Promise((r) => setTimeout(r, 30));
    expect(SESSIONS.size).toBe(before);
    release();
    const res = await pending;
    cageOff();
    if (res.session_id) spawned.add(res.session_id);
    expect(res.isError).toBeFalsy();
    expect(cage.wrapped).toBe(1);
    expect(await pollRunning(sessionIdOf(res), true)).toBe(true);
  }, 20_000);

  it("process_start refuses with the latched reason when they failed", async () => {
    cageOn();
    cage.grantFailure = "the helper exited with 5: Access is denied.";
    const res = await processStartTool.execute({ command: FOREVER });
    cageOff();
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/^process_start: The Windows shell cage could not give its sandbox user access .*\(the helper exited with 5: Access is denied\.\).*Settings → Security/);
    expect(cage.wrapped).toBe(0);
  });

  // Refusing only at the new start would leave the old process dead and
  // nothing in its place.
  it("process_restart refuses before stopping the session it would replace when they failed", async () => {
    release();
    const oldId = await startForever();
    expect(await pollRunning(oldId, true)).toBe(true);
    cageOn();
    cage.grantFailure = "the helper exited with 5: Access is denied.";
    const res = await processRestartTool.execute({ session_id: oldId });
    cageOff();
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/Settings → Security to try again; restarting the app also retries it\. Nothing was stopped or started\.$/);
    expect(await isRunning(oldId)).toBe(true);
  }, 20_000);
});

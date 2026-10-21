// process_* tool tests. These spawn REAL short-lived node processes (no bash,
// no sleep, no port-binding — all flaky in CI) and prove the two bugs this
// change fixes: (a) detached spawn lets process_kill actually terminate the
// child, and (b) process_restart replaces a tracked session with a new one.

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// The vault a secret_env reads from.
const vault = vi.hoisted(() => ({ LAX_TEST_TOKEN: "laxtok_7Qm2Xv9Lp4Rz8Kd3Wn6Tb1Hy5Jc0Fs" } as Record<string, string>));
vi.mock("../secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets.js")>()),
  getSecretsStoreSingleton: () => ({ get: (name: string) => vault[name] }),
}));
// A guarded start asks for the egress proxy's route; these tests start no proxy.
vi.mock("./shell-proxy-env.js", () => ({ shellProxyEnv: async () => ({}), shellProxyEnvSync: () => ({}) }));
// The user's copy of a withheld output: what the inbox producer was handed.
const inboxItems = vi.hoisted(() => [] as Array<{ key: string; program: string; secrets: string[]; reason: string; exit: string; output: string }>);
vi.mock("../inbox/producers.js", () => ({ inboxWithheldOutput: (o: (typeof inboxItems)[number]) => { inboxItems.push(o); } }));
// The port: who holds it, and what the shared reclaim reports killing. Nothing
// here binds a real port.
const port = vi.hoisted(() => ({
  holders: [] as number[],
  reclaimed: [] as number[],
  reclaimCalls: [] as number[],
}));
vi.mock("./process-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-session.js")>()),
  pidsOnPort: () => port.holders,
}));
vi.mock("./dev-server-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dev-server-readiness.js")>()),
  reclaimPort: (p: number) => { port.reclaimCalls.push(p); port.holders = port.holders.filter((pid) => !port.reclaimed.includes(pid)); return port.reclaimed; },
}));

import {
  processStartTool,
  processStatusTool,
  processKillTool,
  processRestartTool,
  runningSessionsForPath,
} from "./process-tools.js";
import { SESSIONS, startSession } from "./process-session.js";
import type { ToolResult } from "../types.js";

// A node one-liner that stays alive until killed. It says "ready" once it runs,
// so a test kills it only after it exists: on Windows a session is a shell
// starting node, and a kill that lands while the shell is still creating node
// misses it — node then starts as an orphan, holds the file's workspace as its
// working directory, and the setup's teardown fails the file with EBUSY. It
// also exits once its parent is gone, so no orphan outlives the file.
const nodeExecutable = process.platform === "win32"
  ? process.execPath.replace(/\\/g, "/")
  : process.execPath;
const MARK = `lax-process-tools-${process.pid}`;
const FOREVER = `"${nodeExecutable}" -e "console.log('ready');setInterval(()=>{try{process.kill(process.ppid,0)}catch{process.exit(0)}},250)" ${MARK}`;

// Last line of defence, and the evidence if the above ever misses: any stand-in
// of this file still running is reported and stopped before the setup removes
// the workspace it may be standing in.
afterAll(() => {
  if (process.platform !== "win32") return;
  const query = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${MARK}*' }`;
  try {
    const left = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(${query}).Count; ${query} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { encoding: "utf-8", windowsHide: true, timeout: 30_000 }).trim();
    if (left !== "0") console.warn(`[process-tools.test] ${left} stand-in process(es) outlived their session and were stopped`);
  } catch (e) {
    console.warn(`[process-tools.test] could not check for leftover stand-ins: ${(e as Error).message}`);
  }
}, 40_000);

// Track every session we start so afterEach can reap leaks even on failure.
const spawned = new Set<string>();

function sessionIdOf(r: ToolResult): string {
  return r.session_id ?? "";
}

async function startForever(): Promise<string> {
  const r = await processStartTool.execute({ command: FOREVER });
  const id = sessionIdOf(r);
  if (id) spawned.add(id);
  await untilStarted(id);
  return id;
}

/** Until the session's program has said it runs, or the session is over. */
async function untilStarted(sessionId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = SESSIONS.get(sessionId);
    if (!session || session.exitedAt !== null || session.stdout.includes("ready") || Date.now() >= deadline) return;
    await new Promise(r => setTimeout(r, 25));
  }
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

// The kill returns before the child is gone. Wait for it to exit: on Windows a
// live child's working directory (the file's temp workspace) cannot be removed,
// and the setup's teardown fails the whole file with EBUSY.
afterEach(async () => {
  for (const id of spawned) {
    await untilStarted(id);
    try { await processKillTool.execute({ session_id: id }); } catch { /* best effort */ }
    await pollRunning(id, false, 5000);
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

// process_restart's port reclaim is the dev-server lifecycle's reclaimPort —
// the one that spares this process and the processes LAX runs for itself. It
// used to kill every holder, the LAX server included.
describe("process_restart port reclaim", () => {
  beforeEach(() => {
    port.holders = [];
    port.reclaimed = [];
    port.reclaimCalls = [];
  });

  it("frees the port through the shared reclaim, then starts", async () => {
    port.holders = [4242];
    port.reclaimed = [4242];
    const res = await processRestartTool.execute({ command: FOREVER, port: 5180 });
    if (res.session_id) spawned.add(res.session_id);
    expect(port.reclaimCalls).toEqual([5180]);
    expect(res.isError).toBeFalsy();
    expect(await pollRunning(sessionIdOf(res), true)).toBe(true);
  }, 20_000);

  it("a holder the reclaim spares (LAX itself, its browser) leaves the port held: nothing is started and the reason names it", async () => {
    port.holders = [process.pid];
    port.reclaimed = [];
    const before = SESSIONS.size;
    const res = await processRestartTool.execute({ command: FOREVER, port: 5180 });
    expect(port.reclaimCalls).toEqual([5180]);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(new RegExp(`port 5180 is still held by pid\\(s\\) ${process.pid}\\. A holder that is Local Agent X itself`));
    expect(SESSIONS.size).toBe(before);
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

// secret_env: a stored key reaches the background process's environment, and
// nothing the model reads back about that process carries the value.
describe("process_start / process_restart with secret_env", () => {
  const VALUE = vault.LAX_TEST_TOKEN;
  // Programs on disk that read their own environment: the sanctioned use. An
  // inline `node -e` that reads it is judged as working on the value, and its
  // output is withheld (the last test here).
  const scriptDir = mkdtempSync(join(tmpdir(), "lax-process-secret-"));
  const printScript = join(scriptDir, "print.js").replace(/\\/g, "/");
  const stayScript = join(scriptDir, "stay.js").replace(/\\/g, "/");
  writeFileSync(printScript, "console.log('tok=' + process.env.LAX_T)");
  writeFileSync(stayScript, "console.log('tok=' + process.env.LAX_T); setInterval(()=>{},1000)");
  afterAll(() => rmSync(scriptDir, { recursive: true, force: true }));
  const PRINT = `"${nodeExecutable}" "${printScript}"`;
  const PRINT_AND_STAY = `"${nodeExecutable}" "${stayScript}"`;
  const SECRET_ENV = { LAX_T: "LAX_TEST_TOKEN" };

  async function outputOf(id: string, want: RegExp, timeoutMs = 8000): Promise<ToolResult> {
    const deadline = Date.now() + timeoutMs;
    let r = await processStatusTool.execute({ session_id: id });
    while (!want.test(String(r.content)) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
      r = await processStatusTool.execute({ session_id: id });
    }
    return r;
  }

  it("puts the value in the child's environment, and every read-back shows [secret NAME]", async () => {
    const started = await processStartTool.execute({ command: PRINT, secret_env: SECRET_ENV });
    const id = sessionIdOf(started);
    spawned.add(id);
    expect(started.isError).toBeFalsy();
    expect(JSON.stringify(started)).not.toContain(VALUE);

    const status = await outputOf(id, /tok=/);
    expect(String(status.content)).toContain("tok=[secret LAX_TEST_TOKEN]");
    expect(JSON.stringify(status)).not.toContain(VALUE);
    // The session's own buffers are what the dev-server crash and readiness
    // reports read; they are scrubbed too. Only the names are kept.
    const session = SESSIONS.get(id)!;
    expect(session.stdout).toContain("tok=[secret LAX_TEST_TOKEN]");
    expect(session.stdout + session.stderr).not.toContain(VALUE);
    expect(session.secretEnv).toEqual(SECRET_ENV);
    expect(JSON.stringify(session.envHint ?? {})).not.toContain(VALUE);
  }, 20_000);

  it("an unchanged restart re-reads the same secret; a new command does not inherit it", async () => {
    const first = sessionIdOf(await processStartTool.execute({ command: PRINT_AND_STAY, secret_env: SECRET_ENV }));
    spawned.add(first);
    expect(String((await outputOf(first, /tok=/)).content)).toContain("tok=[secret LAX_TEST_TOKEN]");

    const respawn = await processRestartTool.execute({ session_id: first });
    const second = sessionIdOf(respawn);
    spawned.add(second);
    expect(JSON.stringify(respawn)).not.toContain(VALUE);
    expect(String((await outputOf(second, /tok=/)).content)).toContain("tok=[secret LAX_TEST_TOKEN]");

    const changed = sessionIdOf(await processRestartTool.execute({ session_id: second, command: PRINT }));
    spawned.add(changed);
    expect(String((await outputOf(changed, /tok=/)).content)).toContain("tok=undefined");
  }, 30_000);

  it("a secret that is not stored stops the call, names it and says how to get it", async () => {
    const before = SESSIONS.size;
    const r = await processStartTool.execute({ command: PRINT, secret_env: { LAX_T: "NOT_STORED" } });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toMatch(/process_start: secret_env: not in the vault: NOT_STORED.*request_secrets/);
    expect(SESSIONS.size).toBe(before);

    const restart = await processRestartTool.execute({ command: PRINT, secret_env: { LAX_T: "NOT_STORED" } });
    expect(String(restart.content)).toMatch(/NOT_STORED.*Nothing was stopped or started/);
  });

  it("an inline program that reads the environment runs, but its output goes to the inbox, not the model", async () => {
    inboxItems.length = 0;
    const reversed = [...VALUE].reverse().join("");
    const started = await processStartTool.execute({
      command: `"${nodeExecutable}" -e "console.log('tok=' + process.env.LAX_T.split('').reverse().join(''))"`,
      secret_env: SECRET_ENV,
    });
    const id = sessionIdOf(started);
    spawned.add(id);
    const session = SESSIONS.get(id)!;
    await session.exited;
    const status = await processStatusTool.execute({ session_id: id });
    expect(String(status.content)).toMatch(/output withheld from the model: this command reads \$LAX_T in inline code/);
    expect(JSON.stringify(status)).not.toContain(reversed.slice(0, 12));
    expect(session.stdout).toMatch(/output withheld/);
    expect(session.stderr).toBe("");
    const item = inboxItems.find((i) => i.key === `withheld:${id}`);
    expect(item).toMatchObject({ secrets: ["LAX_TEST_TOKEN"], reason: "this command reads $LAX_T in inline code", exit: "exit 0" });
    expect(item?.output).toContain(`tok=${reversed}`);
  }, 20_000);

  it("a malformed secret_env stops the call and says what to fix", async () => {
    const asList = await processStartTool.execute({ command: PRINT, secret_env: ["LAX_TEST_TOKEN"] });
    expect(String(asList.content)).toMatch(/secret_env must be an object/);
    const badEnv = await processStartTool.execute({ command: PRINT, secret_env: { "BAD-NAME": "LAX_TEST_TOKEN" } });
    expect(String(badEnv.content)).toMatch(/not a valid environment variable name/);
    const rawValue = await processRestartTool.execute({ command: PRINT, secret_env: { LAX_T: VALUE } });
    expect(String(rawValue.content)).toMatch(/must name a stored secret/);
    expect(String(rawValue.content)).not.toContain(VALUE);
  });
});

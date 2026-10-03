// The sandbox user's grants on the Windows cage: made in the background, never
// on a spawn, awaited by the spawns that can wait, refused retryably to the one
// that cannot, and latched when they fail. The helper is modelled: each call
// waits in `helper.calls` until the test answers it, and a synchronous call
// (which would block the event loop) is recorded so it can be ruled out.
import { homedir } from "node:os";
import { join } from "node:path/win32";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Answer = (error: (Error & { code?: number | string; killed?: boolean }) | null, stdout?: string, stderr?: string) => void;
const helper = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; input?: string; answer: Answer }>,
  syncCalls: [] as string[][],
  workspace: "",
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (_file: string, args: string[], _opts: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    const call: { args: string[]; input?: string; answer: Answer } = { args, answer: (error, stdout = "", stderr = "") => done(error, stdout, stderr) };
    helper.calls.push(call);
    return { stdin: { end: (input?: string) => { call.input = input; } } };
  },
  execFileSync: (_file: string, args: string[]) => { helper.syncCalls.push(args); return ""; },
}));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  workspaceRoot: () => helper.workspace,
}));
const HELPER = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
vi.mock("./win-cage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./win-cage.js")>()),
  resolveWinCageHelper: () => HELPER,
}));
// The trusted shell, under the profile so it needs a read grant.
const SHELL = join(homedir(), "lax-grants-test", "PortableGit", "bin", "bash.exe");
vi.mock("../tools/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/shell-env.js")>()),
  resolveWindowsShell: () => ({ kind: "bash" as const, path: SHELL }),
}));

const SID = "S-1-5-21-9-1006";
const INSTALLED = JSON.stringify({ user: { cred_present: true, marker_user_sid: SID, user: { exists: true } } });
const flush = () => new Promise((r) => setTimeout(r, 0));
const kinds = () => helper.calls.map((c) => c.args[0] === "acl" ? `acl ${c.args[1]}` : c.args[0]);
const last = () => helper.calls[helper.calls.length - 1];
async function answerGrant(outcome: "ok" | "denied"): Promise<void> {
  await flush();
  expect(last().args[0]).toBe("status");
  last().answer(null, INSTALLED);
  await flush();
  expect(last().args.slice(0, 2)).toEqual(["acl", "grant"]);
  if (outcome === "ok") last().answer(null);
  else last().answer(Object.assign(new Error("Command failed"), { code: 5 }), "", "Access is denied.\r\n");
  await flush();
}

let grants: typeof import("./win-cage-grants.js");
let approvalWait: typeof import("../approval-wait.js");
beforeEach(async () => {
  helper.calls = [];
  helper.syncCalls = [];
  helper.workspace = join(homedir(), "lax-grants-test", "workspace");
  // Each test starts from a fresh process's state; the wait ledger is
  // imported alongside so both read the same instance.
  vi.resetModules();
  grants = await import("./win-cage-grants.js");
  approvalWait = await import("../approval-wait.js");
});

describe("win-cage grants: never on a spawn, never on the event loop", () => {
  it("a proof landing with the cage in use starts the grant in the background", async () => {
    grants.restartWinCageGrants(true);
    await flush();
    expect(kinds()).toEqual(["status"]);
    expect(helper.calls[0].args).toEqual(["status", "--sublayer-guid", "6f3b9c1e-4a7d-4e52-9c0b-2d8e5f1a7b34"]);
    helper.calls[0].answer(null, INSTALLED);
    await flush();
    expect(helper.calls[1].args).toEqual(["acl", "grant", "--holder-pid", String(process.pid), "--sandbox-user-sid", SID]);
    expect(JSON.parse(helper.calls[1].input ?? "null")).toEqual({ read: grants.winCageReadGrants(SHELL), write: [helper.workspace] });
    helper.calls[1].answer(null);
    await flush();
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).not.toThrow();
    expect(helper.syncCalls).toEqual([]);
  });

  it("a proof landing with the cage out of use grants nothing", async () => {
    grants.restartWinCageGrants(false);
    await flush();
    expect(helper.calls).toEqual([]);
  });

  // startSession (dev servers, process_*) spawns synchronously through the
  // wrap. The grant it used to make there froze every request for as long as
  // the workspace took to stamp.
  it("the spawn that cannot wait never calls the helper synchronously: it starts the grant and refuses, retryably", async () => {
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(grants.WinCageGrantPendingError);
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(`${grants.WIN_CAGE_GRANT_PENDING_RETRY} Nothing was started.`);
    expect(helper.syncCalls).toEqual([]);
    await flush();
    expect(kinds()).toEqual(["status"]);
    await answerGrant("ok");
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).not.toThrow();
    expect(helper.syncCalls).toEqual([]);
  });

  it("a spawn that can wait joins the grant already running instead of starting another, and books the wait", async () => {
    grants.restartWinCageGrants(true);
    let waitedMs = 0;
    let done = false;
    const spawn = approvalWait.runInApprovalWaitScope(async () => {
      const ready = grants.ensureWinCageGrants(SHELL).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 40));
      waitedMs = approvalWait.currentApprovalWaitMs();
      await answerGrant("ok");
      await ready;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    await spawn;
    expect(done).toBe(true);
    expect(kinds()).toEqual(["status", "acl grant"]);
    expect(waitedMs).toBeGreaterThanOrEqual(30);
  });

  it("an abort ends the wait at once, without throwing", async () => {
    const controller = new AbortController();
    const ready = grants.ensureWinCageGrants(SHELL, controller.signal);
    await flush();
    controller.abort();
    await expect(ready).resolves.toBeUndefined();
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(grants.WinCageGrantPendingError);
  });

  // A program the argv form runs is vetted to sit inside the shell's read
  // roots; once those are granted it needs nothing more, or the sync path
  // would refuse it for good.
  it("a program inside a granted root needs nothing more", async () => {
    grants.restartWinCageGrants(true);
    await answerGrant("ok");
    expect(() => grants.ensureWinCageGrantsSync(join(homedir(), "lax-grants-test", "PortableGit", "cmd", "git.exe"))).not.toThrow();
    await expect(grants.ensureWinCageGrants(join(homedir(), "lax-grants-test", "PortableGit", "usr", "bin", "env.exe"))).resolves.toBeUndefined();
    expect(kinds()).toEqual(["status", "acl grant"]);
  });

  it("a workspace moved since the grant is granted in its turn", async () => {
    grants.restartWinCageGrants(true);
    await answerGrant("ok");
    helper.workspace = join(homedir(), "lax-grants-test", "elsewhere");
    const ready = grants.ensureWinCageGrants(SHELL);
    await answerGrant("ok");
    await ready;
    expect(JSON.parse(last().input ?? "null")).toEqual({ read: [], write: [helper.workspace] });
  });
});

describe("win-cage grants: a failure is latched, not retried by every command", () => {
  it("every spawn refuses with the helper's reason and Settings → Security, and none calls the helper again", async () => {
    grants.restartWinCageGrants(true);
    await answerGrant("denied");
    const asked = helper.calls.length;
    await expect(grants.ensureWinCageGrants(SHELL)).rejects.toThrow(grants.WinCageGrantFailedError);
    await expect(grants.ensureWinCageGrants(SHELL)).rejects.toThrow(/\(the helper exited with 5: Access is denied\.\), so it cannot run commands\. Remove and reinstall the Windows network cage in Settings → Security to try again/);
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(grants.WinCageGrantFailedError);
    await flush();
    expect(helper.calls).toHaveLength(asked);
  });

  it("a helper that reports no sandbox user is a failure too", async () => {
    const ready = grants.ensureWinCageGrants(SHELL);
    await flush();
    last().answer(null, JSON.stringify({ user: { cred_present: false, user: { exists: false } } }));
    await expect(ready).rejects.toThrow(/\(the helper reports no sandbox user\)/);
    expect(kinds()).toEqual(["status"]);
  });

  it("the next proof (a reinstall) clears the latch and grants again", async () => {
    grants.restartWinCageGrants(true);
    await answerGrant("denied");
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(grants.WinCageGrantFailedError);
    grants.restartWinCageGrants(true);
    await answerGrant("ok");
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).not.toThrow();
  });

  // Install and uninstall prove the cage again while a grant may be running;
  // its answer is about the cage as it was, so it neither counts nor latches.
  it("a grant started before a proof lands never records: the one started after it owns the answer", async () => {
    grants.restartWinCageGrants(true);
    await flush();
    const before = helper.calls[0];
    grants.restartWinCageGrants(true);
    await flush();
    expect(helper.calls).toHaveLength(1);
    before.answer(null, INSTALLED);
    await flush();
    last().answer(Object.assign(new Error("Command failed"), { code: 5 }), "", "stale");
    await flush();
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).toThrow(grants.WinCageGrantPendingError);
    await answerGrant("ok");
    expect(kinds()).toEqual(["status", "acl grant", "status", "acl grant"]);
    expect(() => grants.ensureWinCageGrantsSync(SHELL)).not.toThrow();
  });
});

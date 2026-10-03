// The server's proof listener starts the sandbox user's grants over in the
// background (bootstrap-services.ts). win-cage.ts calls it only as a proof
// lands, so a proof that landed before it was registered, or under another
// mode before guarded was chosen, must be handed to it. Without that the
// background grant never runs: the first caged command starts the grant and
// pays for it, waiting when it can, and a start that cannot wait (a dev
// server's) is refused, retryably, until the grant is done. And while the
// cage is in use, Settings reads the grants through the same seam a caged
// start meets, so a failed grant does not read as a working cage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cage = vi.hoisted(() => ({
  realPlatform: process.platform,
  helper: null as string | null,
  // null: the fence proof is still running.
  proof: null as boolean | null,
  listeners: [] as Array<() => void>,
  grants: "made" as "made" | "pending" | { failed: string },
  grantAsks: 0,
}));
vi.mock("./win-cage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./win-cage.js")>()),
  resolveWinCageHelper: () => cage.helper,
  winCageEnforcesSync: () => cage.proof === true,
  winCageProbePending: () => cage.helper !== null && cage.proof === null,
  winCageUnusableReason: () => (cage.proof === true ? null : "modelled"),
  winCageProofView: () => ({ proofPending: cage.helper !== null && cage.proof === null }),
  onWinCageProofSettled: (listener: () => void) => { cage.listeners.push(listener); },
}));
vi.mock("./win-cage-grants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./win-cage-grants.js")>();
  return {
    ...actual,
    ensureWinCageGrantsSync: () => {
      cage.grantAsks++;
      if (cage.grants === "pending") throw new actual.WinCageGrantPendingError();
      if (cage.grants !== "made") throw new actual.WinCageGrantFailedError(cage.grants.failed);
    },
  };
});
vi.mock("../tools/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/shell-env.js")>()),
  resolveWindowsShell: () => ({ kind: "bash" as const, path: "C:\\Program Files\\Git\\bin\\bash.exe" }),
}));

const HELPER = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value });
const prevMode = process.env.LAX_SANDBOX;
const prevDataDir = process.env.LAX_DATA_DIR;
let dataDir: string;
let sandbox: typeof import("./index.js");

/** What the server's listener does with each call: read the status it would
 *  start the grants over for. */
function listener(): { calls: string[]; onSettled: () => void } {
  const calls: string[] = [];
  return { calls, onSettled: () => { calls.push(sandbox.getSandboxStatus().effectiveMode); } };
}
/** The proof lands: win-cage.ts calls every registered listener once. */
function land(ok: boolean): void {
  cage.proof = ok;
  for (const l of cage.listeners) l();
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-proof-replay-"));
  process.env.LAX_DATA_DIR = dataDir;
  setPlatform("win32");
  cage.helper = HELPER;
  cage.proof = null;
  cage.listeners = [];
  cage.grants = "made";
  cage.grantAsks = 0;
  // The selected mode and the registered listener are per process.
  vi.resetModules();
  sandbox = await import("./index.js");
});
afterEach(() => {
  setPlatform(cage.realPlatform);
  if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("startSandboxProof hands the listener a proof it missed", () => {
  it("a proof that landed before the listener was registered reaches it at once, as the cage now stands", () => {
    process.env.LAX_SANDBOX = "guarded";
    cage.proof = true;
    const l = listener();
    sandbox.startSandboxProof(l.onSettled);
    expect(l.calls).toEqual(["guarded"]);
  });

  it("so does one that failed: the listener learns the cage is out of use", () => {
    process.env.LAX_SANDBOX = "guarded";
    cage.proof = false;
    const l = listener();
    sandbox.startSandboxProof(l.onSettled);
    expect(l.calls).toEqual(["host"]);
  });

  it("a proof still running reaches it only as it lands, once", () => {
    process.env.LAX_SANDBOX = "guarded";
    const l = listener();
    sandbox.startSandboxProof(l.onSettled);
    expect(l.calls).toEqual([]);
    land(true);
    expect(l.calls).toEqual(["guarded"]);
  });

  it("with another mode selected there is no cage in use to hand it", () => {
    process.env.LAX_SANDBOX = "host";
    cage.proof = true;
    const l = listener();
    sandbox.startSandboxProof(l.onSettled);
    expect(l.calls).toEqual([]);
  });

  it("choosing guarded after the proof landed under host runs it with the cage in use, and only on the switch", () => {
    process.env.LAX_SANDBOX = "host";
    const l = listener();
    sandbox.startSandboxProof(l.onSettled);
    // The proof ran (a status read starts it) and landed while host was selected.
    land(true);
    expect(l.calls).toEqual(["host"]);
    expect(sandbox.setSandboxMode("guarded")).toEqual({ ok: true, actual: "guarded" });
    expect(l.calls).toEqual(["host", "guarded"]);
    sandbox.setSandboxMode("guarded");
    expect(l.calls).toEqual(["host", "guarded"]);
  });
});

describe("winCageGrantView: what a caged start meets, while the cage is in use", () => {
  beforeEach(() => {
    process.env.LAX_SANDBOX = "guarded";
    cage.proof = true;
  });

  it("nothing to report once the grants are made", () => {
    expect(sandbox.winCageGrantView()).toEqual({});
  });

  it("still being made", () => {
    cage.grants = "pending";
    expect(sandbox.winCageGrantView()).toEqual({ grantPending: true });
  });

  it("failed: the reason and what to do, as every caged command is refused", () => {
    cage.grants = { failed: "the helper exited with 5: Access is denied." };
    const view = sandbox.winCageGrantView();
    expect(view.grantPending).toBeUndefined();
    expect(view.grantFailure).toMatch(/\(the helper exited with 5: Access is denied\.\), so it cannot run commands\. Remove and reinstall the Windows network cage in Settings → Security to try again; restarting the app also retries it\.$/);
  });

  it("with the cage out of use (host chosen, or its proof failed) the grants are not asked", () => {
    cage.grants = { failed: "stale" };
    cage.proof = false;
    expect(sandbox.winCageGrantView()).toEqual({});
    cage.proof = true;
    process.env.LAX_SANDBOX = "host";
    expect(sandbox.winCageGrantView()).toEqual({});
    expect(cage.grantAsks).toBe(0);
  });
});

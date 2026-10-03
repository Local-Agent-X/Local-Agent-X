import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The Windows cage, modelled: a helper path or none, and a fence proof that
// is pending (null) until a test settles it. The default is "no helper" —
// every non-Windows host, and a Windows host without the cage — so no test
// here starts the real proof on a machine that has the cage installed.
// `real` hands the proof's calls to the real module, for a test that points
// it at an empty helper folder; `vanishing` makes the helper disappear after
// its next lookup.
const cage = vi.hoisted(() => {
  const c = {
    realPlatform: process.platform,
    helper: null as string | null,
    proof: null as boolean | null,
    real: false,
    vanishing: false,
    landed: Promise.resolve(false),
    wrapped: [] as string[],
    /** Overrides whether bwrap reads as installed (null: the real check, Linux only). */
    bwrapInstalled: null as boolean | null,
    settle: (_ok: boolean): void => undefined,
    reset(helper: string | null): void {
      c.helper = helper;
      c.proof = null;
      c.real = false;
      c.vanishing = false;
      c.wrapped = [];
      c.bwrapInstalled = null;
      let land!: () => void;
      c.landed = new Promise<void>((r) => { land = r; }).then(() => c.proof === true);
      c.settle = (ok) => { c.proof = ok; land(); };
    },
  };
  return c;
});
vi.mock("./win-cage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./win-cage.js")>();
  return {
    ...actual,
    resolveWinCageHelper: () => {
      if (cage.real) return actual.resolveWinCageHelper();
      const helper = cage.helper;
      if (cage.vanishing) cage.helper = null;
      return helper;
    },
    winCageEnforcesSync: () => (cage.real ? actual.winCageEnforcesSync() : cage.proof === true),
    winCageProbePending: () => (cage.real ? actual.winCageProbePending() : cage.helper !== null && cage.proof === null),
    winCageUnusableReason: () => (cage.real ? actual.winCageUnusableReason() : cage.proof === true ? null : cage.proof === false ? "the fence is not active (test)" : "the fence proof is still running"),
    winCageProofView: () => (cage.real ? actual.winCageProofView()
      : cage.helper !== null && cage.proof === null ? { proofPending: true }
      : cage.proof === false ? { proofPending: false, proofFailure: "the fence is not active (test)" } : { proofPending: false }),
    winCageEnforces: () => (cage.real ? actual.winCageEnforces() : cage.landed),
    // A caged run is a node child that says so; the real one needs the helper.
    wrapForWinCage: (shell: string) => { cage.wrapped.push(shell); return { cmd: process.execPath, args: ["-e", "process.stdout.write('CAGED')"] }; },
  };
});
vi.mock("./win-cage-grants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./win-cage-grants.js")>()),
  ensureWinCageGrants: async () => undefined,
  ensureWinCageGrantsSync: () => undefined,
}));
// bwrap's path is memoized when first probed on Linux; a test standing in for
// Windows must not inherit it unless it asks to (bwrapInstalled).
vi.mock("./bwrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bwrap.js")>();
  return { ...actual, isBwrapAvailable: () => cage.bwrapInstalled ?? (process.platform === "linux" && actual.isBwrapAvailable()) };
});
// A guarded bash asks for the egress proxy's env; these tests start no proxy.
vi.mock("../tools/shell-proxy-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/shell-proxy-env.js")>()),
  shellProxyEnv: async () => ({}),
  shellProxyEnvSync: () => ({}),
}));
// Standing in for Windows elsewhere, the host fallback still needs a shell
// that exists on the machine running the test.
vi.mock("../tools/shell-env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/shell-env.js")>();
  return {
    ...actual,
    resolveWindowsShell: () => (cage.realPlatform === "win32" ? actual.resolveWindowsShell() : { kind: "bash" as const, path: "/bin/bash" }),
  };
});

import { validateSandboxConfig, execInSandbox, getSandboxMode, getSandboxStatus, wrapSpawnForSandbox, isGuardedUsable, sandboxDenialHint, setUnconfinedHostAcknowledgement, awaitSandboxProof, SandboxProofPendingError, setSandboxMode } from "./index.js";
import { _resetWinCageProbe, WIN_CAGE_HELPER_ENV } from "./win-cage.js";
import { bashTool } from "../tools/shell-tool.js";
import { processStartTool } from "../tools/process-tools.js";
import { SESSIONS, startSession } from "../tools/process-session.js";
import { currentApprovalWaitMs, runInApprovalWaitScope } from "../approval-wait.js";
import { withTimeout } from "../tool-execution/tool-timeout.js";
import type { SandboxConfig } from "./types.js";

// Sandbox config validator unit tests. These tests do NOT spawn docker —
// validateSandboxConfig() is pure, and execInSandbox() rejects bad config
// BEFORE invoking docker, so the integration smoke test (case 11) works even
// without a Docker daemon.

const DEFAULTS: SandboxConfig = {
  mode: "docker",
  image: "node:22-alpine",
  workspacePath: "/tmp/sandbox-test-ws",
  networkEnabled: false,
  extraMounts: [],
  memoryLimit: "512m",
};

function withMounts(mounts: string[], over: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...DEFAULTS, ...over, extraMounts: mounts };
}

describe("validateSandboxConfig", () => {
  // Some tests need a real on-disk file as the mount source: the validator
  // now realpath-resolves sources (Bug 6 fix) and rejects missing paths.
  let scratchHost: string;
  let benignSource: string;

  beforeEach(() => {
    scratchHost = realpathSync(mkdtempSync(join(tmpdir(), "lax-sandbox-host-")));
    benignSource = join(scratchHost, "somefile");
    writeFileSync(benignSource, "");
  });

  afterEach(() => {
    try { rmSync(scratchHost, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("accepts a sensible default config", () => {
    expect(validateSandboxConfig(DEFAULTS)).toEqual({ ok: true });
  });

  it("rejects ~/.ssh extraMount", () => {
    const r = validateSandboxConfig(withMounts(["~/.ssh/id_rsa:/root/.ssh/id_rsa"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.ssh/);
  });

  it("rejects ~/.aws extraMount", () => {
    const r = validateSandboxConfig(withMounts(["~/.aws:/aws"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.aws/);
  });

  it("rejects /etc/shadow extraMount", () => {
    const r = validateSandboxConfig(withMounts(["/etc/shadow:/etc/shadow"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\/etc\/shadow/);
  });

  it("rejects extraMount containing a 'secrets' segment", () => {
    const r = validateSandboxConfig(withMounts(["/home/x/secrets/foo:/foo"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/secrets/);
  });

  it("does NOT trip on substring matches like credentialserver.log", () => {
    // Segment-exact check should leave this alone (credentialserver != credentials).
    // Source must exist on disk — realpath check rejects missing paths.
    const benign = join(scratchHost, "credentialserver.log");
    writeFileSync(benign, "");
    const r = validateSandboxConfig(withMounts([`${benign}:/x`]));
    expect(r.ok).toBe(true);
  });

  it("rejects extraMount with .pem suffix", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/cert.pem:/cert.pem"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\.pem/);
  });

  it("rejects extraMount with .key suffix", () => {
    const r = validateSandboxConfig(withMounts(["/tmp/private.key:/k"]));
    expect(r.ok).toBe(false);
  });

  it("allows a benign tmpdir extraMount", () => {
    const r = validateSandboxConfig(withMounts([`${benignSource}:/somefile`]));
    expect(r.ok).toBe(true);
  });

  it("rejects workspacePath = homedir", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: homedir() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/workspacePath/);
  });

  it("rejects workspacePath = '/'", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: "/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/root/i);
  });

  it("rejects networkEnabled=true with any sensitive extraMount", () => {
    // The mount alone would reject; verify network override doesn't open a gap.
    const r = validateSandboxConfig(withMounts(["~/.ssh/id_rsa:/x"], { networkEnabled: true }));
    expect(r.ok).toBe(false);
  });

  it("rejects networkEnabled=true with any non-empty extraMounts (defense in depth)", () => {
    const r = validateSandboxConfig(withMounts([`${benignSource}:/x`], { networkEnabled: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/networkEnabled/);
  });

  it("rejects ~/.npmrc extraMount", () => {
    const r = validateSandboxConfig(withMounts([join(homedir(), ".npmrc") + ":/x"]));
    expect(r.ok).toBe(false);
  });

  it("rejects workspacePath inside ~/.ssh", () => {
    const r = validateSandboxConfig({ ...DEFAULTS, workspacePath: "~/.ssh/work" });
    expect(r.ok).toBe(false);
  });

  it("rejects extraMount with empty source", () => {
    const r = validateSandboxConfig(withMounts([":/dest"]));
    expect(r.ok).toBe(false);
  });

  it("rejects extraMount inside the LAX repo root", () => {
    // Default repo root is process.cwd() which during the test run IS the repo.
    const inRepo = process.cwd();
    const r = validateSandboxConfig(withMounts([`${inRepo}:/lax`]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo/i);
  });
});

describe("guarded sandbox mode (default)", () => {
  const prev = process.env.LAX_SANDBOX;
  afterEach(() => { if (prev === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prev; });

  it("LAX_SANDBOX=guarded resolves to guarded where a kernel backend is usable, else host", () => {
    process.env.LAX_SANDBOX = "guarded";
    expect(getSandboxMode()).toBe(isGuardedUsable() ? "guarded" : "host");
  });

  it.skipIf(!isGuardedUsable())("guarded wrap applies the cage with the platform's network posture", () => {
    process.env.LAX_SANDBOX = "guarded";
    const { cmd, args } = wrapSpawnForSandbox("/bin/bash", ["-c", "echo hi"]);
    // The cage is applied — not a bare passthrough...
    expect(cmd).not.toBe("/bin/bash");
    expect(args.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
    const blob = [cmd, ...args].join(" ");
    if (process.platform === "darwin") {
      // ...macOS guarded admits only the cage's loopback union (the proxy
      // range, the self port, registered services) — never loopback wholesale.
      expect(blob).toContain("(deny network*)");
      expect(blob).toMatch(/\(allow network-outbound \(remote ip "localhost:\d+"\)\)/);
      expect(blob).not.toContain(`"localhost:*"`);
    } else {
      // ...Linux guarded is an empty network namespace; the egress proxy's
      // bridge is the only way out, and it is mounted only when one is live.
      expect(blob).toContain("--unshare-net"); // bwrap
    }
  });

  it.skipIf(isGuardedUsable())("guarded wrap is a passthrough where no kernel backend exists", () => {
    process.env.LAX_SANDBOX = "guarded";
    const { cmd, args } = wrapSpawnForSandbox("/bin/bash", ["-c", "echo hi"]);
    expect(cmd).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
  });
});

describe("effective sandbox status", () => {
  it("reports context-specific shell policy for an unacknowledged host", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_SANDBOX = "host";
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const status = getSandboxStatus();
      expect(status).toMatchObject({
        selectedMode: "host",
        effectiveMode: "host",
        confined: false,
        unconfinedHostAcknowledged: false,
        cronShellAllowed: false,
        delegatedShellAllowed: false,
        apiShellAllowed: false,
      });

      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus()).toMatchObject({
        effectiveMode: "host",
        unconfinedHostAcknowledged: true,
        cronShellAllowed: false,
        delegatedShellAllowed: true,
        apiShellAllowed: true,
      });
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces guarded fallback instead of presenting the selected mode as effective", () => {
    const prev = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    process.env.LAX_SANDBOX = "guarded";
    process.env.LAX_DATA_DIR = dataDir;
    try {
      const status = getSandboxStatus();
      expect(status.selectedMode).toBe("guarded");
      expect(status.effectiveMode).toBe(isGuardedUsable() ? "guarded" : "host");
      expect(status.confined).toBe(isGuardedUsable());
      expect(status.cronShellAllowed).toBe(false);
      expect(status.delegatedShellAllowed).toBe(isGuardedUsable());
      expect(status.apiShellAllowed).toBe(isGuardedUsable());
      if (!isGuardedUsable()) expect(status.fallbackReason).toMatch(/unconfined/i);
    } finally {
      if (prev === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prev;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not carry acknowledgement across selected sandbox modes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    try {
      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(true);
      process.env.LAX_SANDBOX = "guarded";
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(false);
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("persists and revokes the host acknowledgement", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-status-"));
    const prevMode = process.env.LAX_SANDBOX;
    const prevDataDir = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "host";
    try {
      setUnconfinedHostAcknowledgement(true);
      expect(getSandboxStatus().unconfinedHostAcknowledged).toBe(true);
      setUnconfinedHostAcknowledgement(false);
      expect(getSandboxStatus()).toMatchObject({
        unconfinedHostAcknowledged: false,
        delegatedShellAllowed: false,
        apiShellAllowed: false,
      });
    } finally {
      if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
      if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

// While the cage's fence proof runs (seconds after start, longer on a first
// boot) the effective mode reads "host", so a spawn in that window would run
// unconfined unless the seam refuses it or the caller waits for the proof.
describe("Windows cage proof pending: nothing spawns on the unconfined host", () => {
  const HELPER = "C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe";
  const prevMode = process.env.LAX_SANDBOX;
  const prevDataDir = process.env.LAX_DATA_DIR;
  let dataDir: string;
  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value });
  const tick = () => new Promise((r) => setTimeout(r, 50));

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-sandbox-proof-"));
    process.env.LAX_DATA_DIR = dataDir;
    process.env.LAX_SANDBOX = "guarded";
    setPlatform("win32");
    cage.reset(HELPER);
  });
  afterEach(() => {
    setPlatform(cage.realPlatform);
    cage.reset(null);
    if (prevMode === undefined) delete process.env.LAX_SANDBOX; else process.env.LAX_SANDBOX = prevMode;
    if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("the status says the cage is being verified, not that bash is unconfined", () => {
    expect(getSandboxStatus()).toMatchObject({
      selectedMode: "guarded", effectiveMode: "host", confined: false, proofPending: true,
      fallbackReason: "The Windows shell cage is being verified; shell commands wait for it.",
      delegatedShellAllowed: false, apiShellAllowed: false,
    });
    cage.settle(true);
    expect(getSandboxStatus()).toMatchObject({ effectiveMode: "guarded", confined: true, proofPending: false });
  });

  it("the spawn seam refuses, retryably, instead of passing the shell through", () => {
    const wrap = () => wrapSpawnForSandbox("bash.exe", ["-c", "whoami"]);
    expect(wrap).toThrow(SandboxProofPendingError);
    expect(wrap).toThrow(/still being verified; try again in a few seconds/);
    cage.settle(true);
    expect(wrap()).toEqual({ cmd: process.execPath, args: ["-e", "process.stdout.write('CAGED')"] });
  });

  // The wrap picks the platform's cage, as the status does: on a Linux CI
  // runner standing in for Windows, an installed bwrap took the Windows spawn.
  it("a guarded spawn on Windows uses the Windows cage even where bwrap is installed", () => {
    cage.bwrapInstalled = true;
    cage.settle(true);
    expect(wrapSpawnForSandbox("bash.exe", ["-c", "whoami"])).toEqual({ cmd: process.execPath, args: ["-e", "process.stdout.write('CAGED')"] });
    expect(cage.wrapped).toEqual(["bash.exe"]);
  });

  it("a proof still running after the wait bound leaves the refusal in place", async () => {
    await awaitSandboxProof({ timeoutMs: 20 });
    expect(() => wrapSpawnForSandbox("bash.exe", ["-c", "whoami"])).toThrow(SandboxProofPendingError);
  });

  it("a helper gone between the status read and the wrap refuses rather than running on the host", () => {
    cage.settle(true);
    cage.vanishing = true;
    expect(() => wrapSpawnForSandbox("bash.exe", ["-c", "whoami"])).toThrow(/no longer where the cage was proven, so nothing was started/);
    expect(cage.wrapped).toEqual([]);
  });

  it("choosing guarded while the proof runs says to retry; after a failed proof it says the installed cage is broken", () => {
    expect(setSandboxMode("guarded")).toEqual({ ok: false, actual: "host", error: "The Windows shell cage is still being verified; try again in a few seconds." });
    cage.settle(false);
    const failed = setSandboxMode("guarded");
    expect(failed.error).toMatch(/^The Windows network cage is installed but not working \(the fence is not active \(test\)\)/);
    expect(failed.error).not.toContain("install it from Settings → Security first");
  });

  // Charging the wait to the command's own budget would leave a wait longer
  // than the timeout 1 ms, and a false "Command timed out".
  it("bash keeps its whole timeout after the wait, and announces the wait", async () => {
    const progress: string[] = [];
    const run = bashTool.execute({ command: "echo HOST", timeout: 1500, _onProgress: (m: string) => progress.push(m) });
    await new Promise((r) => setTimeout(r, 1600));
    cage.settle(true);
    const result = await run;
    expect(result.status).not.toBe("timeout");
    expect(String(result.content)).toBe("CAGED");
    expect(progress).toEqual([expect.stringMatching(/^Waiting for the Windows shell cage check to finish/)]);
  });

  it("the harness backstop leaves the wait out", async () => {
    const run = runInApprovalWaitScope(() => withTimeout(bashTool.execute({ command: "echo HOST" }), 600, "bash", currentApprovalWaitMs));
    await new Promise((r) => setTimeout(r, 700));
    cage.settle(true);
    expect(String((await run).content)).toBe("CAGED");
  });

  it("an abort during the wait returns Aborted and starts nothing", async () => {
    const controller = new AbortController();
    const run = bashTool.execute({ command: "echo HOST" }, controller.signal);
    await tick();
    controller.abort();
    const result = await run;
    expect(result).toMatchObject({ isError: true, content: "Aborted" });
    cage.settle(true);
    await tick();
    expect(cage.wrapped).toEqual([]);
  });

  // A machine without the cage helper has nothing to verify: guarded falls
  // back to the visible host at once, and a dev server's synchronous start is
  // never held for a proof that could only fail.
  it("with no helper, the first status is not pending and a session starts", async () => {
    const prevHelper = process.env[WIN_CAGE_HELPER_ENV];
    const prevProgramData = process.env.ProgramData;
    cage.real = true;
    delete process.env[WIN_CAGE_HELPER_ENV];
    process.env.ProgramData = dataDir;
    _resetWinCageProbe();
    try {
      const first = getSandboxStatus();
      expect(first).toMatchObject({ selectedMode: "guarded", effectiveMode: "host", proofPending: false });
      expect(getSandboxStatus().proofPending).toBe(false);
      const started = startSession("echo HOST");
      expect(started).not.toHaveProperty("error");
      const session = "session" in started ? started.session : null;
      await session?.exited;
      expect(session?.stdout.trim()).toBe("HOST");
      expect(first.fallbackReason).toMatch(/helper is not present/);
    } finally {
      _resetWinCageProbe();
      if (prevHelper === undefined) delete process.env[WIN_CAGE_HELPER_ENV]; else process.env[WIN_CAGE_HELPER_ENV] = prevHelper;
      if (prevProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = prevProgramData;
    }
  });

  it("bash waits for the proof, then runs caged once it is proven", async () => {
    let finished = false;
    const run = bashTool.execute({ command: "echo HOST" }).finally(() => { finished = true; });
    await tick();
    expect(finished).toBe(false);
    expect(cage.wrapped).toEqual([]);
    cage.settle(true);
    const result = await run;
    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toBe("CAGED");
    expect(cage.wrapped).toHaveLength(1);
  });

  it("bash waits for the proof, then runs on the visible host fallback when it failed", async () => {
    const run = bashTool.execute({ command: "echo HOST" });
    await tick();
    cage.settle(false);
    const result = await run;
    expect(String(result.content).trim()).toBe("HOST");
    expect(cage.wrapped).toEqual([]);
    expect(getSandboxStatus()).toMatchObject({
      effectiveMode: "host", confined: false, proofPending: false,
      fallbackReason: "The Windows network cage is not active (the fence is not active (test)), so bash is unconfined.",
    });
  });

  it("process_start waits for the proof too, then starts the session caged", async () => {
    let finished = false;
    const run = processStartTool.execute({ command: "echo HOST" }).finally(() => { finished = true; });
    await tick();
    expect(finished).toBe(false);
    cage.settle(true);
    const result = await run;
    expect(result.isError).toBeFalsy();
    expect(cage.wrapped).toHaveLength(1);
    const session = SESSIONS.get(result.session_id ?? "");
    await session?.exited;
    expect(session?.stdout).toBe("CAGED");
  });
});

describe("sandboxDenialHint", () => {
  const epermAws = "cat: /Users/dad/.aws/credentials: Operation not permitted";

  it("names the cage + off switch when a credential dir is denied under a cage", () => {
    const hint = sandboxDenialHint("guarded", epermAws);
    expect(hint).toBeTruthy();
    expect(hint).toContain('mode "guarded"');
    expect(hint).toContain("~/.aws");
    expect(hint).toMatch(/Settings/);
  });

  it("fires for seatbelt and bwrap too", () => {
    expect(sandboxDenialHint("seatbelt", "ls: /Users/dad/.ssh: Operation not permitted")).toContain("~/.ssh");
    expect(sandboxDenialHint("bwrap", "Permission denied: /home/u/.kube/config")).toContain("~/.kube");
  });

  it("returns null in host/docker mode (no kernel cage to blame)", () => {
    expect(sandboxDenialHint("host", epermAws)).toBeNull();
    expect(sandboxDenialHint("docker", epermAws)).toBeNull();
  });

  it("returns null on an ordinary permission error with no cage-denied path", () => {
    expect(sandboxDenialHint("guarded", "cat: /etc/secret: Permission denied")).toBeNull();
  });

  it("returns null on a non-permission failure", () => {
    expect(sandboxDenialHint("guarded", "bash: frobnicate: command not found")).toBeNull();
  });

  it("does NOT blame the cage for ~/.config — guarded exempts it", () => {
    // ~/.config is readable in guarded, so an EPERM mentioning it is a real error.
    expect(sandboxDenialHint("guarded", "open /Users/dad/.config/x: Operation not permitted")).toBeNull();
    // ...but strict seatbelt DOES deny ~/.config, so there it's the cage.
    expect(sandboxDenialHint("seatbelt", "open /Users/dad/.config/x: Operation not permitted")).toContain("~/.config");
  });
});

describe("execInSandbox integration smoke (rejection path)", () => {
  it("returns exitCode 1 with a clear stderr when extraMounts is sensitive", () => {
    // No Docker invocation should occur — rejection happens before docker spawn.
    const result = execInSandbox("echo hi", { extraMounts: ["~/.ssh:/x"] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Sandbox config rejected/);
    expect(result.stdout).toBe("");
  });

  // Regression guard: execInSandbox() must not fail validation on its own
  // defaults. Previously DEFAULT_CONFIG.workspacePath was "./workspace",
  // which resolved into the repo root and the validator rejected — making
  // docker-mode bash always return "Sandbox config rejected: ..." since
  // the only real caller (shell-tools.ts) passes no override.
  it("does NOT reject validation when called with no config override", () => {
    // Docker is probably not running in CI/test envs; we only assert that
    // we got past validation. If validation rejected, stderr would start
    // with "Sandbox config rejected". After the docker spawn it'll be some
    // other error (docker not installed, image not found, etc.) — that's
    // fine, the validation gate is what we care about.
    const result = execInSandbox("echo hi");
    expect(result.stderr).not.toMatch(/Sandbox config rejected/);
  });
});
